import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLoadoutSettingsStorage } from "./settings-storage.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadout settings storage", () => {
	it("migrates legacy pi-loadout settings into shared extension settings", async () => {
		const { sharedPath, legacyPath } = await createTempPaths();
		await writeFile(
			legacyPath,
			`${JSON.stringify({ state: { general: { showStatus: false } } }, null, 2)}\n`,
			"utf8",
		);

		const storage = createLoadoutSettingsStorage({ sharedPath, legacyPath });
		const state = await storage.load(createContext());

		expect(state).toEqual({ general: { showStatus: false } });
		expect(JSON.parse(await readFile(sharedPath, "utf8"))).toEqual({
			providers: {
				"pi-loadout": { state: { general: { showStatus: false } } },
			},
		});
	});

	it("keeps shared settings authoritative over legacy settings", async () => {
		const { sharedPath, legacyPath } = await createTempPaths();
		const storage = createLoadoutSettingsStorage({ sharedPath, legacyPath });
		await storage.save({ general: { showStatus: true } }, createContext());
		await writeFile(
			legacyPath,
			`${JSON.stringify({ state: { general: { showStatus: false } } }, null, 2)}\n`,
			"utf8",
		);

		await expect(storage.load(createContext())).resolves.toEqual({ general: { showStatus: true } });
	});

	it("ignores malformed legacy settings after notifying", async () => {
		const { sharedPath, legacyPath } = await createTempPaths();
		await writeFile(legacyPath, "{", "utf8");
		const notifications: string[] = [];

		const storage = createLoadoutSettingsStorage({ sharedPath, legacyPath });

		await expect(storage.load(createContext(notifications))).resolves.toBeUndefined();
		expect(notifications[0]).toContain("Could not migrate legacy pi-loadout settings");
	});
});

async function createTempPaths(): Promise<{ sharedPath: string; legacyPath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-loadout-settings-"));
	tempDirs.push(dir);
	return {
		sharedPath: join(dir, "ext-settings.json"),
		legacyPath: join(dir, "pi-loadout-settings.json"),
	};
}

function createContext(notifications: string[] = []): ExtensionContext {
	return {
		ui: {
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext;
}
