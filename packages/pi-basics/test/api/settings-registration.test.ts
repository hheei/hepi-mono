import { describe, expect, test } from "bun:test";
import {
	createHePiSettingsRegistry,
	type HePiSettingsProvider,
	listHePiSettings,
	registerHePiSettingsIfAbsent,
} from "../../src/api/index.js";

function provider(id: string): HePiSettingsProvider {
	return {
		id,
		title: id,
		groups: [],
		storage: {
			load: async () => ({}),
			save: async () => {},
		},
	};
}

describe("HEPI settings registration", () => {
	test("keeps all child providers and ignores repeated session registration", () => {
		const registry = createHePiSettingsRegistry();
		registerHePiSettingsIfAbsent(provider("advisor"), registry);
		registerHePiSettingsIfAbsent(provider("auto-title"), registry);
		registerHePiSettingsIfAbsent(provider("advisor"), registry);

		expect(listHePiSettings(registry, { includeEmpty: true }).map((item) => item.id)).toEqual([
			"advisor",
			"auto-title",
		]);
	});
});
