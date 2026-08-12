import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEditSettingsProvider,
	createFffSettingsProvider,
	DEFAULT_EDIT_MODE,
	DEFAULT_FFF_SETTINGS,
	editModeFromState,
	fffSettingsFromState,
	readEditMode,
} from "../../src/fff/settings.js";

describe("FFF settings", () => {
	test("uses defaults and ignores invalid persisted primitive values", () => {
		expect(fffSettingsFromState(undefined)).toEqual(DEFAULT_FFF_SETTINGS);
		expect(
			fffSettingsFromState({
				fff: {
					autocomplete: false,
					grepEnhancement: true,
				},
			}),
		).toEqual({
			shellPath: DEFAULT_FFF_SETTINGS.shellPath,
			bashOutputTailKiB: 10,
			autocomplete: false,
			grepEnhancement: true,
			readEnhancement: true,
			findEnhancement: true,
		});
	});

	test("registers settings in pi-ext-tools/fff without runtime side effects", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-fff-settings-"));
		try {
			const path = join(directory, "settings.json");
			const provider = createFffSettingsProvider({ path });
			await provider.storage.save({ fff: { autocomplete: false } }, { sessionId: "settings-test" });
			expect(await provider.storage.load({ sessionId: "settings-test" })).toEqual({
				fff: { autocomplete: false },
			});
			expect(
				fffSettingsFromState(await provider.storage.load({ sessionId: "settings-test" })),
			).toEqual({
				shellPath: DEFAULT_FFF_SETTINGS.shellPath,
				bashOutputTailKiB: 10,
				autocomplete: false,
				grepEnhancement: true,
				readEnhancement: true,
				findEnhancement: true,
			});
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				"pi-ext-tools": { fff: { autocomplete: false } },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("loads and persists the static Edit Mode catalog setting", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-edit-settings-"));
		try {
			const path = join(directory, "settings.json");
			const provider = createEditSettingsProvider({ path });
			await provider.storage.save({ edit: { mode: "native" } }, { sessionId: "settings-test" });
			expect(readEditMode(path)).toBe("native");
			expect(editModeFromState({ edit: { mode: "none" } })).toBe("none");
			expect(editModeFromState({ edit: { mode: "unsupported" } })).toBe(DEFAULT_EDIT_MODE);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				"pi-ext-tools": { edit: { mode: "native" } },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
