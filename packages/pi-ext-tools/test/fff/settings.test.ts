import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFffSettingsProvider,
	DEFAULT_FFF_SETTINGS,
	fffSettingsFromState,
	loadFffSettings,
} from "../../src/fff/settings.js";

describe("FFF settings", () => {
	test("uses defaults and ignores invalid persisted primitive values", () => {
		expect(fffSettingsFromState(undefined)).toEqual(DEFAULT_FFF_SETTINGS);
		expect(
			fffSettingsFromState({
				fff: {
					autocomplete: false,
					grepEnhancement: true,
					statusUI: null,
				},
			}),
		).toEqual({
			autocomplete: false,
			grepEnhancement: true,
			readEnhancement: true,
			findEnhancement: true,
			statusUI: true,
		});
	});

	test("falls back to legacy pi-fff settings when new section is absent", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-fff-legacy-settings-"));
		try {
			const path = join(directory, "settings.json");
			await writeFile(
				path,
				JSON.stringify({ "pi-fff": { features: { findEnhancement: false } } }),
				"utf8",
			);
			const provider = createFffSettingsProvider({ path });
			expect(await loadFffSettings(provider, { sessionId: "legacy-test", cwd: directory })).toEqual(
				{
					autocomplete: true,
					grepEnhancement: true,
					readEnhancement: true,
					findEnhancement: false,
					statusUI: true,
				},
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("registers settings in pi-ext-tools/fff without runtime side effects", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-fff-settings-"));
		try {
			const path = join(directory, "settings.json");
			const provider = createFffSettingsProvider({ path });
			await provider.storage.save(
				{ fff: { autocomplete: false, statusUI: false } },
				{ sessionId: "settings-test" },
			);
			expect(await provider.storage.load({ sessionId: "settings-test" })).toEqual({
				fff: { autocomplete: false, statusUI: false },
			});
			expect(
				fffSettingsFromState(await provider.storage.load({ sessionId: "settings-test" })),
			).toEqual({
				autocomplete: false,
				grepEnhancement: true,
				readEnhancement: true,
				findEnhancement: true,
				statusUI: false,
			});
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				"pi-ext-tools": { fff: { autocomplete: false, statusUI: false } },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
