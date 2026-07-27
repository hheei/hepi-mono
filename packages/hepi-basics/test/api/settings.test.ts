import { describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	createGlobalJsonStorage,
	createHepiSettingsRegistry,
	createSessionStorage,
	getHepiRuntimeSettingsRegistry,
	getHepiSettings,
	type HepiContext,
	type HepiSettingsProvider,
	listHepiSettings,
	registerHepiSettings,
	replaceHepiSettings,
} from "../../src/core/api/index.js";

const context = (sessionId: string): HepiContext => ({ sessionId });
const storage = createSessionStorage();
const providerFor = (
	id: string,
	title: string,
	groups: HepiSettingsProvider["groups"] = [],
): HepiSettingsProvider => ({
	id,
	title,
	groups,
	storage,
});

describe("HePi settings API", () => {
	test("isolates live runtime registries", () => {
		const first = getHepiRuntimeSettingsRegistry({ events: createEventBus() });
		const second = getHepiRuntimeSettingsRegistry({ events: createEventBus() });
		const unregisterFirst = first.register(providerFor("shared", "First"));
		second.register(providerFor("shared", "Second"));

		expect(first.get("shared")?.title).toBe("First");
		expect(second.get("shared")?.title).toBe("Second");
		unregisterFirst();
		expect(first.get("shared")).toBeUndefined();
		expect(second.get("shared")?.title).toBe("Second");
	});

	test("orders providers and filters groups without fields", () => {
		const registry = createHepiSettingsRegistry();
		registerHepiSettings(providerFor("empty", "Empty"), registry);
		registerHepiSettings(providerFor("z", "Same", [{ id: "g", title: "G", fields: [] }]), registry);
		registerHepiSettings(providerFor("a", "Same", [{ id: "g", title: "G", fields: [] }]), registry);
		registerHepiSettings(
			{
				...providerFor("panel", "Panel", [{ id: "g", title: "G", fields: [] }]),
				panels: [{ id: "panel", label: "Panel", render: () => ["panel"] }],
			},
			registry,
		);

		expect(listHepiSettings(registry).map((provider) => provider.id)).toEqual(["panel"]);
		expect(
			listHepiSettings(registry, { includeEmpty: true }).map((provider) => provider.id),
		).toEqual(["empty", "panel", "a", "z"]);
		expect(() => registerHepiSettings(providerFor("a", "Again"), registry)).toThrow(
			"HePi settings provider id collision: a",
		);
	});

	test("disposers remove only their own provider", () => {
		const registry = createHepiSettingsRegistry();
		const first = providerFor("owned", "First");
		const second = providerFor("owned", "Second");
		const unregisterFirst = registerHepiSettings(first, registry);
		const unregisterSecond = replaceHepiSettings(second, registry);

		unregisterFirst();
		expect(getHepiSettings("owned", registry)).toBe(second);
		const unregisterSameProviderAgain = replaceHepiSettings(second, registry);
		unregisterSecond();
		expect(getHepiSettings("owned", registry)).toBe(second);
		unregisterSameProviderAgain();
		unregisterSameProviderAgain();
		expect(getHepiSettings("owned", registry)).toBeUndefined();
	});

	test("rejects registered setting keys without detailed descriptions", () => {
		const registry = createHepiSettingsRegistry();
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
		expect(() => registerHepiSettings(provider, registry)).toThrow(
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
