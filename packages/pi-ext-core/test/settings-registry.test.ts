import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { getRuntimeSettingsRegistry, type SettingsProvider } from "../src/index.js";

function provider(id: string, groupId: string): SettingsProvider {
	return {
		id,
		title: id,
		groups: [
			{
				id: groupId,
				title: groupId,
				fields: [
					{
						id: "enabled",
						label: "Enabled",
						type: "boolean",
						defaultValue: false,
						description: "Controls the settings registry collision test feature.",
						parse: (draft) => draft === "true",
					},
				],
			},
		],
		storage: { load: () => undefined, save: () => undefined },
	};
}

test("rejects duplicate settings groups and releases ownership on dispose", () => {
	const pi = { events: {} } as ExtensionAPI;
	const registry = getRuntimeSettingsRegistry(pi);
	const dispose = registry.register(provider("first", "shared"));

	expect(() => registry.register(provider("second", "shared"))).toThrow(
		"Settings group id collision: shared",
	);
	dispose();
	expect(() => registry.register(provider("second", "shared"))).not.toThrow();
});

test("replacement atomically transfers a provider's group ownership", () => {
	const pi = { events: {} } as ExtensionAPI;
	const registry = getRuntimeSettingsRegistry(pi);
	const staleDispose = registry.register(provider("first", "old"));
	registry.replace(provider("first", "new"));

	staleDispose();
	expect(registry.get("first")?.groups[0]?.id).toBe("new");
	expect(() => registry.register(provider("second", "old"))).not.toThrow();
	expect(() => registry.register(provider("third", "new"))).toThrow(
		"Settings group id collision: new",
	);
});

test("non-UI groups share the provider collision domain", () => {
	const pi = { events: {} } as ExtensionAPI;
	const registry = getRuntimeSettingsRegistry(pi);
	const dispose = registry.registerGroups("loadout", ["loadout"]);

	expect(() => registry.register(provider("provider", "loadout"))).toThrow(
		"Settings group id collision: loadout",
	);
	dispose();
	expect(() => registry.register(provider("provider", "loadout"))).not.toThrow();
});
