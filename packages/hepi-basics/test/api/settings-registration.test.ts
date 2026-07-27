import { describe, expect, test } from "bun:test";
import {
	createHepiSettingsRegistry,
	type HepiSettingsProvider,
	listHepiSettings,
	registerHepiSettingsIfAbsent,
} from "../../src/core/api/index.js";

function provider(id: string): HepiSettingsProvider {
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
		const registry = createHepiSettingsRegistry();
		registerHepiSettingsIfAbsent(provider("advisor"), registry);
		registerHepiSettingsIfAbsent(provider("auto-title"), registry);
		registerHepiSettingsIfAbsent(provider("advisor"), registry);

		expect(listHepiSettings(registry, { includeEmpty: true }).map((item) => item.id)).toEqual([
			"advisor",
			"auto-title",
		]);
	});
});
