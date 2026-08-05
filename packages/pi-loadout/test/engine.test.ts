import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	getDisabledSkillKeys,
	observeLoadoutToolActivation,
	type PiSettingsPaths,
	registerLoadoutResource,
	registerManagedLoadoutTool,
} from "@hheei/pi-ext-core";
import { createLoadoutEngine } from "../src/engine.js";
import { updateLoadoutSelection } from "../src/storage.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function paths(): Promise<PiSettingsPaths> {
	const root = await mkdtemp(join(tmpdir(), "pi-loadout-"));
	temporaryPaths.push(root);
	return { globalPath: join(root, "global.json"), projectPath: join(root, "project.json") };
}

function host(): { readonly pi: ExtensionAPI; readonly activeSets: string[][] } {
	const activeSets: string[][] = [];
	const tools: ToolInfo[] = [
		{ name: "find", sourceInfo: { source: "builtin" } },
		{ name: "custom", sourceInfo: { source: "extension" } },
		{ name: "third_party", sourceInfo: { source: "third-party" } },
	] as ToolInfo[];
	const pi = {
		events: {},
		getAllTools: () => tools,
		getActiveTools: () => ["find", "third_party"],
		getCommands: () => [
			{ name: "skill:format", source: "skill" },
			{ name: "skill:review", source: "skill" },
		],
		registerTool: () => undefined,
		setActiveTools(names: string[]) {
			activeSets.push(names);
		},
	} as unknown as ExtensionAPI;
	return { pi, activeSets };
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
	test("resolves scoped deltas, preserves observed defaults, and clears on disposal", async () => {
		const h = host();
		const settings = await paths();
		await writeFile(
			settings.globalPath,
			JSON.stringify({ "pi-loadout": { disabled: ["tool:find", "skill:format"] } }),
		);
		await writeFile(
			settings.projectPath,
			JSON.stringify({ "pi-loadout": { enabled: ["tool:custom"] } }),
		);
		registerManagedLoadoutTool(
			h.pi,
			{
				id: "custom",
				owner: "@hheei/pi-loadout-test",
				group: "HEPI",
				priority: 1,
				conflictSets: [],
				defaultActive: false,
			},
			{ name: "custom" } as never,
		);
		const activeSnapshots: string[] = [];
		const activationController = new AbortController();
		observeLoadoutToolActivation(h.pi, {
			signal: activationController.signal,
			onChange(snapshot) {
				activeSnapshots.push(
					snapshot === undefined ? "none" : [...snapshot.activeIds].sort().join(","),
				);
			},
		});
		const engine = createLoadoutEngine(h.pi, { paths: settings });
		await engine.start({ cwd: process.cwd() } as ExtensionContext, new AbortController().signal);
		expect(h.activeSets.at(-1)).toEqual(["custom", "third_party"]);
		expect(activeSnapshots).toEqual(["none", "custom,third_party"]);
		expect([...getDisabledSkillKeys(h.pi)]).toEqual(["skill:format"]);
		engine.dispose();
		expect(h.activeSets.at(-1)).toEqual(["find", "third_party"]);
		expect(activeSnapshots).toEqual(["none", "custom,third_party", "none"]);
		expect([...getDisabledSkillKeys(h.pi)]).toEqual([]);
		activationController.abort();
	});

	test("rolls back a failed first inventory apply so the engine can retry", async () => {
		const h = host();
		const settings = await paths();
		await writeFile(
			settings.globalPath,
			JSON.stringify({ "pi-loadout": { disabled: ["tool:find"] } }),
		);
		let failFirstSet = true;
		const setActiveTools = h.pi.setActiveTools.bind(h.pi);
		(h.pi as { setActiveTools(names: string[]): void }).setActiveTools = (names): void => {
			setActiveTools(names);
			if (!failFirstSet) return;
			failFirstSet = false;
			throw new Error("setActiveTools failed");
		};
		const engine = createLoadoutEngine(h.pi, { paths: settings });
		const failedStart = new AbortController();
		await expectRejected(
			() => engine.start({ cwd: process.cwd() } as ExtensionContext, failedStart.signal),
			"setActiveTools failed",
		);
		failedStart.abort();
		expect(h.activeSets.slice(-2)).toEqual([["third_party"], ["find", "third_party"]]);
		expect([...getDisabledSkillKeys(h.pi)]).toEqual([]);
		await engine.start({ cwd: process.cwd() } as ExtensionContext, new AbortController().signal);
		expect(h.activeSets.at(-1)).toEqual(["third_party"]);
		engine.dispose();
	});

	test("publishes agent resource activation without adding it to host tools", async () => {
		const h = host();
		const settings = await paths();
		await writeFile(
			settings.globalPath,
			JSON.stringify({ "pi-loadout": { disabled: ["agent:Explore"] } }),
		);
		const dispose = registerLoadoutResource(h.pi, {
			id: "agent:Explore",
			kind: "agent",
			group: "𖠌 Agents",
			priority: 0,
			conflictSets: [],
			defaultActive: true,
			label: "Explore",
			description: "Read-only explorer.",
			summary: "○ inherit",
			projectPrivate: false,
			owner: "@hheei/pi-subagents",
		});
		const snapshots: Array<{
			readonly known: readonly string[];
			readonly active: readonly string[];
		}> = [];
		const controller = new AbortController();
		observeLoadoutToolActivation(h.pi, {
			signal: controller.signal,
			onChange(snapshot) {
				if (snapshot === undefined) return;
				snapshots.push({
					known: [...snapshot.knownIds].sort(),
					active: [...snapshot.activeIds].sort(),
				});
			},
		});
		const engine = createLoadoutEngine(h.pi, { paths: settings });
		await engine.start({ cwd: process.cwd() } as ExtensionContext, controller.signal);
		expect(h.activeSets.at(-1)).toEqual(["find", "third_party"]);
		expect(snapshots.at(-1)).toEqual({
			known: ["agent:Explore", "custom", "find", "third_party"],
			active: ["find", "third_party"],
		});
		engine.dispose();
		dispose();
	});

	test("restores host before observer cleanup and remains retryable", async () => {
		const h = host();
		const settings = await paths();
		const controller = new AbortController();
		let notifications = 0;
		observeLoadoutToolActivation(h.pi, {
			signal: controller.signal,
			onChange(_snapshot) {
				if (++notifications === 3) throw new Error("observer failed");
			},
		});
		const engine = createLoadoutEngine(h.pi, { paths: settings });
		await engine.start({ cwd: process.cwd() } as ExtensionContext, new AbortController().signal);
		expect(() => engine.dispose()).toThrow("observer failed");
		expect(h.activeSets.at(-1)).toEqual(["find", "third_party"]);
		expect(engine.snapshot()).toBeDefined();
		controller.abort();
		engine.dispose();
		expect(engine.snapshot()).toBeUndefined();
	});

	test("writes scope deltas, clears fallback choices, and repairs the modified key", async () => {
		const settings = await paths();
		await writeFile(
			settings.globalPath,
			JSON.stringify({ "pi-loadout": { enabled: ["tool:find"], disabled: ["tool:grep"] } }),
		);
		await writeFile(
			settings.projectPath,
			JSON.stringify({ "pi-loadout": { enabled: ["tool:find"], disabled: ["tool:find"] } }),
		);
		await updateLoadoutSelection({
			cwd: process.cwd(),
			paths: settings,
			scope: "project",
			key: "tool:find",
			selection: "inherit",
			defaultActive: true,
		});
		await updateLoadoutSelection({
			cwd: process.cwd(),
			paths: settings,
			scope: "global",
			key: "tool:find",
			selection: "enabled",
			defaultActive: true,
		});
		await updateLoadoutSelection({
			cwd: process.cwd(),
			paths: settings,
			scope: "project",
			key: "tool:private",
			selection: "disabled",
			defaultActive: true,
			projectPrivate: true,
		});
		expect(JSON.parse(await readFile(settings.globalPath, "utf8"))).toEqual({
			"pi-loadout": { disabled: ["tool:grep"] },
		});
		expect(JSON.parse(await readFile(settings.projectPath, "utf8"))).toEqual({
			"pi-loadout": { disabled: ["tool:private"] },
		});
		await expectRejected(
			() =>
				updateLoadoutSelection({
					cwd: process.cwd(),
					paths: settings,
					scope: "project",
					key: "tool:private",
					selection: "inherit",
					defaultActive: true,
					projectPrivate: true,
				}),
			"Project-private Loadout selection cannot inherit",
		);
		await expectRejected(
			() =>
				updateLoadoutSelection({
					cwd: process.cwd(),
					paths: settings,
					scope: "global",
					key: "find",
					selection: "enabled",
					defaultActive: true,
				}),
			"Expected canonical tool:<name> or skill:<name> key",
		);
		await expectRejected(
			() =>
				updateLoadoutSelection({
					cwd: process.cwd(),
					paths: settings,
					scope: "global",
					key: "tool:private",
					selection: "enabled",
					defaultActive: false,
					projectPrivate: true,
				}),
			"Project-private Loadout selection cannot use global scope",
		);
		await updateLoadoutSelection({
			cwd: process.cwd(),
			paths: settings,
			scope: "project",
			key: "tool:private",
			selection: "enabled",
			defaultActive: true,
			projectPrivate: true,
		});
		expect(JSON.parse(await readFile(settings.projectPath, "utf8"))).toEqual({});
	});
});
