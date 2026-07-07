import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	createGeneralPaneGroups,
	createPaneState,
	loadProviderState,
	namespaceGroupId,
	normalizeSettingsProvider,
	routeProviderChange,
	splitNamespacedGroupId,
} from "../src/settings/provider.js";
import type {
	ExtensionSettingsProvider,
	SettingsStorageAdapter,
} from "../src/settings/register.js";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

const generalGroup = {
	id: "general",
	title: "General",
	description: (theme: Theme) => theme.fg("muted", "General options"),
	fields: [{ id: "enabled", label: "Enabled", defaultValue: true }],
};

const providerGroup = {
	id: "advanced/path",
	title: "Advanced",
	fields: [{ id: "mode", label: "Mode", defaultValue: "auto" }],
};

const storage: SettingsStorageAdapter = {
	load: () => ({ general: { enabled: false } }),
	save: () => {},
};

function createProvider(overrides: Partial<ExtensionSettingsProvider> = {}) {
	return normalizeSettingsProvider({
		id: "sample",
		title: "Sample",
		description: "Sample provider.",
		generalGroups: [generalGroup],
		groups: [providerGroup],
		storage,
		...overrides,
	});
}

describe("settings provider helpers", () => {
	it("normalizes optional provider collections", () => {
		const provider = normalizeSettingsProvider({ id: "empty", title: "Empty", storage });

		expect(provider.generalGroups).toEqual([]);
		expect(provider.generalPanels).toEqual([]);
		expect(provider.groups).toEqual([]);
		expect(provider.panels).toEqual([]);
		expect(provider.storage).toBe(storage);
	});

	it("loads provider state with saved values merged over defaults", async () => {
		const provider = createProvider();

		expect(await loadProviderState(provider, undefined as never)).toEqual({
			general: { enabled: false },
			"advanced/path": { mode: "auto" },
		});
	});

	it("creates namespaced general pane groups with provider labels", () => {
		const [group] = createGeneralPaneGroups([createProvider()]);

		expect(group?.id).toBe("sample/general");
		expect(group?.title).toBe("Sample / General");
		expect(typeof group?.description).toBe("function");
		expect(typeof group?.description === "function" ? group.description(theme) : undefined).toBe(
			"Sample provider. General options",
		);
	});

	it("projects provider-local state into pane-local namespaced groups", () => {
		const provider = createProvider();
		const providerStates = new Map([[provider.id, { general: { enabled: false } }]]);

		expect(createPaneState([provider], providerStates, (item) => item.generalGroups)).toEqual({
			"sample/general": { enabled: false },
		});
		expect(createPaneState([provider], new Map(), (item) => item.groups)).toEqual({
			"sample/advanced/path": { mode: "auto" },
		});
	});

	it("routes namespaced changes back to provider-local state", () => {
		const provider = createProvider();
		const routed = routeProviderChange(
			[provider],
			new Map([[provider.id, { "advanced/path": { mode: "auto" } }]]),
			{
				groupId: namespaceGroupId(provider.id, "advanced/path"),
				fieldId: "mode",
				value: "manual",
				state: { "sample/advanced/path": { mode: "manual" } },
			},
		);

		expect(routed?.provider).toBe(provider);
		expect(routed?.change.groupId).toBe("advanced/path");
		expect(routed?.change.state).toEqual({ "advanced/path": { mode: "manual" } });
	});

	it("ignores changes without a registered provider namespace", () => {
		const provider = createProvider();

		expect(
			routeProviderChange([provider], new Map(), {
				groupId: "missing/general",
				fieldId: "enabled",
				value: false,
				state: {},
			}),
		).toBeUndefined();
	});

	it("splits namespaced group ids at the provider boundary only", () => {
		expect(splitNamespacedGroupId("sample/advanced/path")).toEqual({
			providerId: "sample",
			groupId: "advanced/path",
		});
		expect(splitNamespacedGroupId("plain")).toEqual({ providerId: "", groupId: "plain" });
	});
});
