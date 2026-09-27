import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ExtensionSettingsPaths, getDisabledSkillKeys } from "@hheei/pi-ext-core";
import { afterEach, describe, expect, test } from "vitest";
import { createLoadoutEngine } from "../../src/loadout/engine.js";
import {
	type UpdateLoadoutSelectionsOptions,
	updateLoadoutSelections,
} from "../../src/loadout/storage.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function paths(): Promise<ExtensionSettingsPaths> {
	const root = await mkdtemp(join(tmpdir(), "pi-settings-loadout-"));
	temporaryPaths.push(root);
	return { globalPath: join(root, "global.json"), projectPath: join(root, "project.json") };
}

function host(): {
	readonly pi: ExtensionAPI;
	readonly activeSets: string[][];
	readonly commands: Array<{ readonly name: string; readonly source: string }>;
} {
	const activeSets: string[][] = [];
	const commands = [
		{ name: "skill:format", source: "skill" },
		{ name: "skill:review", source: "skill" },
	];
	const pi = {
		events: {},
		getActiveTools: () => ["read", "bash"],
		getCommands: () => [...commands],
		setActiveTools(names: string[]) {
			activeSets.push(names);
		},
	} as unknown as ExtensionAPI;
	return { pi, activeSets, commands };
}

async function expectRejected(operation: () => Promise<void>, message: string): Promise<void> {
	let failure: unknown;
	try {
		await operation();
	} catch (error: unknown) {
		failure = error;
	}
	expect(failure instanceof Error ? failure.message : String(failure)).toContain(message);
}

describe("headless Loadout engine", () => {
	test("publishes disabled skills and never changes Pi's active tools", async () => {
		const h = host();
		const settings = await paths();
		await writeFile(
			settings.globalPath,
			JSON.stringify({ loadout: { disabled: ["skill:format", "tool:find"] } }),
		);
		const engine = createLoadoutEngine(h.pi, { paths: settings });
		await engine.start({ cwd: process.cwd() } as ExtensionContext, new AbortController().signal);

		expect([...getDisabledSkillKeys(h.pi)]).toEqual(["skill:format"]);
		// Tools are owned by their contributors: a legacy `tool:` key is inert.
		expect(h.activeSets).toEqual([]);
		engine.dispose();
		expect([...getDisabledSkillKeys(h.pi)]).toEqual([]);
	});

	test("reload republishes skill state from the persisted layers", async () => {
		const h = host();
		const settings = await paths();
		const engine = createLoadoutEngine(h.pi, { paths: settings });
		await engine.start({ cwd: process.cwd() } as ExtensionContext, new AbortController().signal);
		expect([...getDisabledSkillKeys(h.pi)]).toEqual([]);

		await writeFile(
			settings.globalPath,
			JSON.stringify({ loadout: { disabled: ["skill:review"] } }),
		);
		await engine.reload();
		expect([...getDisabledSkillKeys(h.pi)]).toEqual(["skill:review"]);

		await writeFile(settings.globalPath, JSON.stringify({}));
		await engine.reload();
		expect([...getDisabledSkillKeys(h.pi)]).toEqual([]);
		expect(h.activeSets).toEqual([]);
		engine.dispose();
	});

	test("rolls back a failed first apply so the engine can retry", async () => {
		const h = host();
		const settings = await paths();
		await writeFile(
			settings.globalPath,
			JSON.stringify({ loadout: { disabled: ["skill:format"] } }),
		);
		let failFirstRead = true;
		(h.pi as { getCommands(): unknown }).getCommands = () => {
			if (!failFirstRead) return [...h.commands];
			failFirstRead = false;
			throw new Error("getCommands failed");
		};
		const engine = createLoadoutEngine(h.pi, { paths: settings });
		await expectRejected(
			() => engine.start({ cwd: process.cwd() } as ExtensionContext, new AbortController().signal),
			"getCommands failed",
		);
		expect([...getDisabledSkillKeys(h.pi)]).toEqual([]);
		expect(engine.snapshot()).toBeUndefined();
		await engine.start({ cwd: process.cwd() } as ExtensionContext, new AbortController().signal);
		expect([...getDisabledSkillKeys(h.pi)]).toEqual(["skill:format"]);
		engine.dispose();
	});

	test("rejects a second start, a reload while inactive, and stays idempotent on disposal", async () => {
		const h = host();
		const settings = await paths();
		const engine = createLoadoutEngine(h.pi, { paths: settings });
		await expectRejected(() => engine.reload(), "Loadout engine is not active");
		await engine.start({ cwd: process.cwd() } as ExtensionContext, new AbortController().signal);
		await expectRejected(
			() => engine.start({ cwd: process.cwd() } as ExtensionContext, new AbortController().signal),
			"Loadout engine is already active",
		);
		expect(engine.snapshot()).toBeDefined();
		engine.dispose();
		engine.dispose();
		expect(engine.snapshot()).toBeUndefined();
	});

	test("writes scope deltas, clears fallback choices, and repairs the modified key", async () => {
		const settings = await paths();
		const update = (
			scope: UpdateLoadoutSelectionsOptions["scope"],
			selections: UpdateLoadoutSelectionsOptions["selections"],
		) => updateLoadoutSelections({ cwd: process.cwd(), paths: settings, scope, selections });
		await writeFile(
			settings.globalPath,
			JSON.stringify({
				loadout: { enabled: ["skill:format"], disabled: ["agent:Explore"] },
			}),
		);
		await writeFile(
			settings.projectPath,
			JSON.stringify({
				loadout: { enabled: ["skill:format"], disabled: ["skill:format"] },
			}),
		);
		await update("project", [
			{ key: "skill:format", selection: "inherit", defaultActive: true },
			{
				key: "agent:private",
				selection: "disabled",
				defaultActive: true,
				projectPrivate: true,
			},
		]);
		await update("global", [{ key: "skill:format", selection: "enabled", defaultActive: true }]);
		expect(JSON.parse(await readFile(settings.globalPath, "utf8"))).toEqual({
			loadout: { disabled: ["agent:Explore"] },
		});
		expect(JSON.parse(await readFile(settings.projectPath, "utf8"))).toEqual({
			loadout: { disabled: ["agent:private"] },
		});
		await expectRejected(
			() =>
				update("project", [
					{
						key: "agent:private",
						selection: "inherit",
						defaultActive: true,
						projectPrivate: true,
					},
				]),
			"Project-private Loadout selection cannot inherit",
		);
		await expectRejected(
			() => update("global", [{ key: "find", selection: "enabled", defaultActive: true }]),
			"Expected canonical skill:<name> or agent:<name> key",
		);
		await expectRejected(
			() => update("global", [{ key: "tool:find", selection: "enabled", defaultActive: true }]),
			"Expected canonical skill:<name> or agent:<name> key",
		);
		await expectRejected(
			() =>
				update("global", [
					{
						key: "agent:private",
						selection: "enabled",
						defaultActive: false,
						projectPrivate: true,
					},
				]),
			"Project-private Loadout selection cannot use global scope",
		);
		await update("project", [
			{
				key: "agent:private",
				selection: "enabled",
				defaultActive: true,
				projectPrivate: true,
			},
		]);
		expect(JSON.parse(await readFile(settings.projectPath, "utf8"))).toEqual({});
	});

	test("keeps legacy tool keys in the file while ignoring them", async () => {
		const h = host();
		const settings = await paths();
		await writeFile(settings.globalPath, JSON.stringify({ loadout: { disabled: ["tool:read"] } }));
		const engine = createLoadoutEngine(h.pi, { paths: settings });
		await engine.start({ cwd: process.cwd() } as ExtensionContext, new AbortController().signal);
		expect([...getDisabledSkillKeys(h.pi)]).toEqual([]);

		await updateLoadoutSelections({
			cwd: process.cwd(),
			paths: settings,
			scope: "global",
			selections: [{ key: "skill:review", selection: "disabled", defaultActive: true }],
		});
		expect(JSON.parse(await readFile(settings.globalPath, "utf8"))).toEqual({
			loadout: { disabled: ["skill:review", "tool:read"] },
		});
		engine.dispose();
	});
});
