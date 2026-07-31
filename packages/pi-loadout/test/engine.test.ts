import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	getDisabledSkillKeys,
	observeLoadoutToolActivation,
	type PiSettingsPaths,
	registerManagedLoadoutTool,
} from "@hheei/pi-ext-core";
import { createLoadoutEngine } from "../src/engine.js";

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

describe("headless Loadout engine", () => {
	test("merges project overrides, preserves observed defaults, and clears on disposal", async () => {
		const h = host();
		const settings = await paths();
		await writeFile(
			settings.globalPath,
			JSON.stringify({
				"pi-loadout": { tools: { "tool:find": false }, skills: { "skill:format": false } },
			}),
		);
		await writeFile(
			settings.projectPath,
			JSON.stringify({ "pi-loadout": { tools: { "tool:custom": true } } }),
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
});
