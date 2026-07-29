import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	getHepiSettings,
} from "../../../hepi-basics/src/core/index.js";
import {
	CAVEMAN_DEFAULTS_GROUP,
	CAVEMAN_MAIN_MODE_FIELD,
	CAVEMAN_SETTINGS_PROVIDER_ID,
	CAVEMAN_SUBAGENT_MODE_FIELD,
	createCavemanSettingsProvider,
	loadCavemanDefaults,
	registerCavemanHepiSettings,
} from "../../src/pi-caveman/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createProject(settings: unknown): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-caveman-config-"));
	temporaryDirectories.push(cwd);
	await writeFile(join(cwd, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	return cwd;
}

describe("Caveman HEPI settings", () => {
	test("registers once and disposes through the runtime registry", async () => {
		const pi = { events: createEventBus() } as unknown as ExtensionAPI;
		const registry = getHepiRuntimeSettingsRegistry(pi);
		const unregister = await registerCavemanHepiSettings(pi);
		expect(unregister).toBeFunction();
		await expect(registerCavemanHepiSettings(pi)).rejects.toThrow(
			"HePi settings provider id collision: pi-caveman",
		);
		expect(getHepiSettings(CAVEMAN_SETTINGS_PROVIDER_ID, registry)?.origin).toBe(
			"@hheei/hepi-skills",
		);
		unregister?.();
		expect(getHepiSettings(CAVEMAN_SETTINGS_PROVIDER_ID, registry)).toBeUndefined();
	});

	test("loads validated main and subagent defaults", async () => {
		const cwd = await createProject({
			hepi: { caveman: { defaults: { mainMode: "lite", subagentMode: "wenyan-ultra" } } },
		});

		expect(await loadCavemanDefaults(join(cwd, "settings.json"))).toEqual({
			mainMode: "lite",
			subagentMode: "wenyan-ultra",
		});
	});

	test("falls back per invalid field", async () => {
		const cwd = await createProject({
			hepi: { caveman: { defaults: { mainMode: "verbose", subagentMode: "off" } } },
		});

		expect(await loadCavemanDefaults(join(cwd, "settings.json"))).toEqual({
			mainMode: "full",
			subagentMode: "off",
		});
	});

	test("provider exposes enum fields and preserves unrelated settings", async () => {
		const cwd = await createProject({
			hepi: { goal: { enabled: true } },
			other: { value: 42 },
		});
		const provider = createCavemanSettingsProvider({
			settingsFilePath: join(cwd, "settings.json"),
		});
		const group = provider.groups[0];

		expect(group?.fields.map((field) => field.id)).toEqual([
			CAVEMAN_MAIN_MODE_FIELD,
			CAVEMAN_SUBAGENT_MODE_FIELD,
		]);
		expect(group?.fields[0]?.options?.map((option) => option.value)).toContain("off");

		await provider.storage.save(
			{
				[CAVEMAN_DEFAULTS_GROUP]: {
					[CAVEMAN_MAIN_MODE_FIELD]: "ultra",
					[CAVEMAN_SUBAGENT_MODE_FIELD]: "wenyan-full",
				},
			},
			{ sessionId: "test", cwd },
		);

		const root: unknown = JSON.parse(await readFile(join(cwd, "settings.json"), "utf8"));
		expect(root).toEqual({
			hepi: {
				goal: { enabled: true },
				caveman: {
					defaults: { mainMode: "ultra", subagentMode: "wenyan-full" },
				},
			},
			other: { value: 42 },
		});
		expect(await provider.storage.load({ sessionId: "test", cwd })).toEqual({
			defaults: { mainMode: "ultra", subagentMode: "wenyan-full" },
		});
	});
});
