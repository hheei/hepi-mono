import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	createBashSettingsProvider,
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
			const path = join(directory, "ext_settings.json");
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
				fff: { autocomplete: false },
				bash: { outputTailKiB: 20 },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
