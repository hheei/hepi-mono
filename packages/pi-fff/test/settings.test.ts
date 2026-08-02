import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFffSettingsProvider,
	DEFAULT_FFF_SETTINGS,
	fffSettingsFromState,
} from "../src/settings.js";

describe("FFF settings", () => {
	test("uses defaults and ignores invalid persisted primitive values", () => {
		expect(fffSettingsFromState(undefined)).toEqual(DEFAULT_FFF_SETTINGS);
		expect(
			fffSettingsFromState({
				features: {
					autocomplete: false,
					grepEnhancement: true,
					statusUI: null,
				},
			}),
		).toEqual({
			autocomplete: false,
			grepEnhancement: true,
			statusUI: true,
		});
	});

	test("registers settings in the pi-fff section without runtime side effects", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hepi-fff-settings-"));
		try {
			const path = join(directory, "settings.json");
			const provider = createFffSettingsProvider({ path });
			await provider.storage.save(
				{ features: { autocomplete: false, statusUI: false } },
				{ sessionId: "settings-test" },
			);
			expect(await provider.storage.load({ sessionId: "settings-test" })).toEqual({
				features: { autocomplete: false, statusUI: false },
			});
			expect(
				fffSettingsFromState(await provider.storage.load({ sessionId: "settings-test" })),
			).toEqual({
				autocomplete: false,
				grepEnhancement: true,
				statusUI: false,
			});
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				"pi-fff": { features: { autocomplete: false, statusUI: false } },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
