import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHePiSettings } from "@hheei/pi-basics";
import {
	createPonytailSettingsProvider,
	loadPonytailDefaults,
	PONYTAIL_DEFAULTS_GROUP,
	PONYTAIL_SETTINGS_PROVIDER_ID,
	registerPonytailHePiSettings,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createProject(settings: unknown): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-ponytail-config-"));
	temporaryDirectories.push(cwd);
	await mkdir(join(cwd, ".pi"));
	await writeFile(join(cwd, ".pi", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	return cwd;
}

describe("Ponytail HEPI settings", () => {
	test("registers idempotently through pi-basics public API", async () => {
		expect(await registerPonytailHePiSettings()).toBeTrue();
		expect(await registerPonytailHePiSettings()).toBeTrue();
		expect(getHePiSettings(PONYTAIL_SETTINGS_PROVIDER_ID)?.origin).toBe("@hheei/pi-ponytail");
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
		expect(await loadPonytailDefaults(cwd)).toEqual({
			mainMode: "lite",
			subagentMode: "ultra",
			hideStatus: true,
			quietStartup: true,
		});
	});

	test("provider preserves unrelated project settings", async () => {
		const cwd = await createProject({ "pi-basics": { goal: { enabled: true } }, other: 42 });
		const provider = createPonytailSettingsProvider();
		expect(provider.groups[0]?.fields.map((field) => field.id)).toEqual([
			"mainMode",
			"subagentMode",
			"hideStatus",
			"quietStartup",
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

		const root: unknown = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"));
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
