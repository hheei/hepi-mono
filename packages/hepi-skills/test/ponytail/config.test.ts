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
	createPonytailSettingsProvider,
	loadPonytailDefaults,
	PONYTAIL_DEFAULTS_GROUP,
	PONYTAIL_SETTINGS_PROVIDER_ID,
	registerPonytailHepiSettings,
} from "../../src/pi-ponytail/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createProject(settings: unknown): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-ponytail-config-"));
	temporaryDirectories.push(cwd);
	await writeFile(join(cwd, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	return cwd;
}

describe("Ponytail HEPI settings", () => {
	test("registers once and disposes through the runtime registry", async () => {
		const pi = { events: createEventBus() } as unknown as ExtensionAPI;
		const registry = getHepiRuntimeSettingsRegistry(pi);
		const unregister = await registerPonytailHepiSettings(pi);
		expect(unregister).toBeFunction();
		await expect(registerPonytailHepiSettings(pi)).rejects.toThrow(
			"HePi settings provider id collision: pi-ponytail",
		);
		expect(getHepiSettings(PONYTAIL_SETTINGS_PROVIDER_ID, registry)?.origin).toBe(
			"@hheei/hepi-skills",
		);
		unregister?.();
		expect(getHepiSettings(PONYTAIL_SETTINGS_PROVIDER_ID, registry)).toBeUndefined();
	});

	test("loads validated modes and presentation flags", async () => {
		const cwd = await createProject({
			"pi-ponytail": {
				defaults: {
					mainMode: "lite",
					subagentMode: "ultra",
					hideStatus: true,
					quietStartup: true,
				},
			},
		});
		expect(await loadPonytailDefaults(join(cwd, "settings.json"))).toEqual({
			mainMode: "lite",
			subagentMode: "ultra",
			hideStatus: true,
			quietStartup: true,
		});
	});

	test("provider preserves unrelated global settings", async () => {
		const cwd = await createProject({ "pi-basics": { goal: { enabled: true } }, other: 42 });
		const provider = createPonytailSettingsProvider({
			settingsFilePath: join(cwd, "settings.json"),
		});
		expect(provider.groups[0]?.fields.map((field) => field.id)).toEqual([
			"mainMode",
			"subagentMode",
		]);

		await provider.storage.save(
			{
				[PONYTAIL_DEFAULTS_GROUP]: {
					mainMode: "off",
					subagentMode: "ultra",
					hideStatus: false,
					quietStartup: true,
				},
			},
			{ sessionId: "test", cwd },
		);

		const root: unknown = JSON.parse(await readFile(join(cwd, "settings.json"), "utf8"));
		expect(root).toEqual({
			"pi-basics": { goal: { enabled: true } },
			other: 42,
			"pi-ponytail": {
				defaults: {
					mainMode: "off",
					subagentMode: "ultra",
					hideStatus: false,
					quietStartup: true,
				},
			},
		});
	});
});
