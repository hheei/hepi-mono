import { describe, expect, test } from "bun:test";
import {
	createGlobalJsonStorage,
	createHePiSettingsRegistry,
	createSessionStorage,
	type HePiContext,
	type HePiSettingsProvider,
	listHePiSettings,
	registerHePiSettings,
} from "../../src/api/index.js";

const context = (sessionId: string): HePiContext => ({ sessionId });
const storage = createSessionStorage();
const providerFor = (
	id: string,
	title: string,
	groups: HePiSettingsProvider["groups"] = [],
): HePiSettingsProvider => ({
	id,
	title,
	groups,
	storage,
});

describe("HePi settings API", () => {
	test("orders providers and filters groups without fields", () => {
		const registry = createHePiSettingsRegistry();
		registerHePiSettings(providerFor("empty", "Empty"), registry);
		registerHePiSettings(providerFor("z", "Same", [{ id: "g", title: "G", fields: [] }]), registry);
		registerHePiSettings(providerFor("a", "Same", [{ id: "g", title: "G", fields: [] }]), registry);
		registerHePiSettings(
			{
				...providerFor("panel", "Panel", [{ id: "g", title: "G", fields: [] }]),
				panels: [{ id: "panel", label: "Panel", render: () => ["panel"] }],
			},
			registry,
		);

		expect(listHePiSettings(registry).map((provider) => provider.id)).toEqual(["panel"]);
		expect(
			listHePiSettings(registry, { includeEmpty: true }).map((provider) => provider.id),
		).toEqual(["empty", "panel", "a", "z"]);
		expect(() => registerHePiSettings(providerFor("a", "Again"), registry)).toThrow(
			"HePi settings provider id collision: a",
		);
	});

	test("rejects registered setting keys without detailed descriptions", () => {
		const registry = createHePiSettingsRegistry();
		const provider = providerFor("short-description", "Short description", [
			{
				id: "general",
				title: "General",
				fields: [
					{
						id: "enabled",
						label: "Enabled",
						type: "boolean",
						defaultValue: false,
						description: "Too short",
						parse: (value) => value === "true",
					},
				],
			},
		]);
		expect(() => registerHePiSettings(provider, registry)).toThrow(
			"requires a detailed description of at least 20 characters",
		);
	});

	test("session storage isolates contexts and propagates backend errors", async () => {
		const first = context("first");
		const second = context("second");
		const firstState = { group: { field: true } };
		await storage.save(firstState, first);

		expect(await storage.load(first)).toEqual(firstState);
		expect(await storage.load(second)).toBeUndefined();
		await storage.close?.(first);
		expect(await storage.load(first)).toEqual(firstState);

		const error = new Error("save failed");
		const backend = {
			load: async () => {
				throw error;
			},
			save: async () => {
				throw error;
			},
		};
		const jsonStorage = createGlobalJsonStorage(backend);
		await expect(jsonStorage.load(first)).rejects.toBe(error);
		await expect(jsonStorage.save(firstState, first)).rejects.toBe(error);
	});
});
