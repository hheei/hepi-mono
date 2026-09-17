import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	createBashSettingsProvider,
	createEditSettingsProvider,
	createFffSettingsProvider,
	DEFAULT_EDIT_MODE,
	DEFAULT_FFF_SETTINGS,
	editModeFromState,
	fffSettingsFromState,
	loadFffSettings,
	readEditMode,
	resolveEditCatalog,
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

	test("persists grouped FFF and Bash settings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-fff-settings-"));
		try {
			const path = join(directory, "settings.json");
			const fffProvider = createFffSettingsProvider({ path });
			const bashProvider = createBashSettingsProvider({ path });
			const context = { sessionId: "settings-test" };
			await fffProvider.storage.save({ fff: { autocomplete: false } }, context);
			await bashProvider.storage.save({ bash: { outputTailKiB: 20 } }, context);
			expect(await fffProvider.storage.load(context)).toEqual({
				fff: { autocomplete: false },
			});
			expect(await bashProvider.storage.load(context)).toEqual({
				bash: { outputTailKiB: 20 },
			});
			expect(await loadFffSettings(fffProvider, bashProvider, context)).toEqual({
				shellPath: DEFAULT_FFF_SETTINGS.shellPath,
				bashOutputTailKiB: 20,
				autocomplete: false,
				grepEnhancement: true,
				readEnhancement: true,
				findEnhancement: true,
			});
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				"pi-ext-tools": {
					fff: { autocomplete: false },
					bash: { outputTailKiB: 20 },
				},
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("resolves auto Edit Mode from the session model", () => {
		expect(resolveEditCatalog("auto", { id: "gpt-5" })).toBe("apply_patch");
		expect(resolveEditCatalog("auto", { provider: "openai", id: "GPT-4.1" })).toBe("apply_patch");
		expect(resolveEditCatalog("auto", { name: "ChatGPT" })).toBe("apply_patch");
		expect(resolveEditCatalog("auto", { id: "claude-sonnet-4" })).toBe("native");
		expect(resolveEditCatalog("auto", undefined)).toBe("native");
		expect(resolveEditCatalog("apply_patch", { id: "claude-sonnet-4" })).toBe("apply_patch");
		expect(resolveEditCatalog("native", { id: "gpt-5" })).toBe("native");
		expect(resolveEditCatalog("none", { id: "gpt-5" })).toBe("none");
	});

	test("loads and persists the static Edit Mode catalog setting", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-edit-settings-"));
		try {
			const path = join(directory, "settings.json");
			const provider = createEditSettingsProvider({ path });
			await provider.storage.save({ edit: { mode: "native" } }, { sessionId: "settings-test" });
			expect(readEditMode(path)).toBe("native");
			expect(editModeFromState({ edit: { mode: "none" } })).toBe("none");
			expect(editModeFromState({ edit: { mode: "auto" } })).toBe("auto");
			expect(editModeFromState({ edit: { mode: "unsupported" } })).toBe(DEFAULT_EDIT_MODE);
			expect(DEFAULT_EDIT_MODE).toBe("auto");
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				"pi-ext-tools": { edit: { mode: "native" } },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
