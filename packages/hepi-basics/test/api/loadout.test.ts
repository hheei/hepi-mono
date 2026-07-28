import { describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	createHepiLoadoutGroupRegistry,
	getHepiRuntimeLoadoutGroupRegistry,
	registerHepiLoadoutGroup,
	registerHepiRuntimeLoadoutGroup,
	replaceHepiLoadoutGroup,
} from "../../src/core/api/index.js";

const group = (id: string, label = id) => ({ id, label, items: [`tool:${id}`] });

describe("HePi Loadout group registry", () => {
	test("isolates runtime registries and validates owned registration cleanup", () => {
		const first = getHepiRuntimeLoadoutGroupRegistry({ events: createEventBus() });
		const second = getHepiRuntimeLoadoutGroupRegistry({ events: createEventBus() });
		const firstGroup = group("first", "First");
		const unregister = registerHepiLoadoutGroup(firstGroup, first);
		registerHepiLoadoutGroup(group("first", "Second"), second);

		expect(first.get("first")?.label).toBe("First");
		expect(second.get("first")?.label).toBe("Second");
		unregister();
		expect(first.get("first")).toBeUndefined();
		expect(second.get("first")?.label).toBe("Second");
	});

	test("rejects collisions and keeps replacement disposal generation-safe", () => {
		const registry = createHepiLoadoutGroupRegistry();
		const unregisterOriginal = registerHepiLoadoutGroup(group("shared", "Original"), registry);
		expect(() => registerHepiLoadoutGroup(group("shared"), registry)).toThrow(
			"HePi Loadout group id collision: shared",
		);
		const unregisterReplacement = replaceHepiLoadoutGroup(group("shared", "Replacement"), registry);
		unregisterOriginal();
		expect(registry.get("shared")?.label).toBe("Replacement");
		unregisterReplacement();
		expect(registry.get("shared")).toBeUndefined();
	});

	test("removes factory-time groups on session shutdown", () => {
		const events: Array<() => void> = [];
		const pi = {
			events: createEventBus(),
			on: (_event: "session_shutdown", handler: () => void) => {
				events.push(handler);
			},
		};
		const unregister = registerHepiRuntimeLoadoutGroup(pi, group("factory"));
		const registry = getHepiRuntimeLoadoutGroupRegistry(pi);
		expect(registry.get("factory")).toBeDefined();
		events[0]?.();
		expect(registry.get("factory")).toBeUndefined();
		unregister();
	});
});
