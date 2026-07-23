import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHePiSettings } from "@hheei/pi-basics";
import {
	CAVEMAN_DEFAULTS_GROUP,
	CAVEMAN_MAIN_MODE_FIELD,
	CAVEMAN_SETTINGS_PROVIDER_ID,
	CAVEMAN_SUBAGENT_MODE_FIELD,
	createCavemanSettingsProvider,
	loadCavemanDefaults,
	registerCavemanHePiSettings,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createProject(settings: unknown): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-caveman-config-"));
	temporaryDirectories.push(cwd);
	await mkdir(join(cwd, ".pi"));
	await writeFile(join(cwd, ".pi", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	return cwd;
}

describe("Caveman HEPI settings", () => {
	test("registers idempotently through pi-basics public API", async () => {
		expect(await registerCavemanHePiSettings()).toBeTrue();
		expect(await registerCavemanHePiSettings()).toBeTrue();
		expect(getHePiSettings(CAVEMAN_SETTINGS_PROVIDER_ID)?.origin).toBe("@hheei/pi-caveman");
	});

	test("loads validated main and subagent defaults", async () => {
		const cwd = await createProject({
			"pi-caveman": { defaults: { mainMode: "lite", subagentMode: "wenyan-ultra" } },
		});

		expect(await loadCavemanDefaults(cwd)).toEqual({
			mainMode: "lite",
			subagentMode: "wenyan-ultra",
		});
	});

	test("falls back per invalid field", async () => {
		const cwd = await createProject({
			"pi-caveman": { defaults: { mainMode: "verbose", subagentMode: "off" } },
		});

		expect(await loadCavemanDefaults(cwd)).toEqual({ mainMode: "full", subagentMode: "off" });
	});

	test("provider exposes enum fields and preserves unrelated settings", async () => {
		const cwd = await createProject({
			"pi-basics": { goal: { enabled: true } },
			other: { value: 42 },
		});
		const provider = createCavemanSettingsProvider();
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

		const root: unknown = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"));
		expect(root).toEqual({
			"pi-basics": { goal: { enabled: true } },
			other: { value: 42 },
			"pi-caveman": {
				defaults: { mainMode: "ultra", subagentMode: "wenyan-full" },
			},
		});
		expect(await provider.storage.load({ sessionId: "test", cwd })).toEqual({
			defaults: { mainMode: "ultra", subagentMode: "wenyan-full" },
		});
	});
});
