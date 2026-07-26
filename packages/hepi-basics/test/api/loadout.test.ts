import { describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	createHePiLoadoutGroupRegistry,
	getHePiRuntimeLoadoutGroupRegistry,
	registerHePiLoadoutGroup,
	registerHePiRuntimeLoadoutGroup,
	replaceHePiLoadoutGroup,
} from "../../src/core/api/index.js";

const group = (id: string, label = id) => ({ id, label, items: [`tool:${id}`] });

describe("HePi Loadout group registry", () => {
	test("isolates runtime registries and validates owned registration cleanup", () => {
		const first = getHePiRuntimeLoadoutGroupRegistry({ events: createEventBus() });
		const second = getHePiRuntimeLoadoutGroupRegistry({ events: createEventBus() });
		const firstGroup = group("first", "First");
		const unregister = registerHePiLoadoutGroup(firstGroup, first);
		registerHePiLoadoutGroup(group("first", "Second"), second);

		expect(first.get("first")?.label).toBe("First");
		expect(second.get("first")?.label).toBe("Second");
		unregister();
		expect(first.get("first")).toBeUndefined();
		expect(second.get("first")?.label).toBe("Second");
	});

	test("rejects collisions and keeps replacement disposal generation-safe", () => {
		const registry = createHePiLoadoutGroupRegistry();
		registerHePiLoadoutGroup(group("shared", "Original"), registry);
		expect(() => registerHePiLoadoutGroup(group("shared"), registry)).toThrow(
			"HePi Loadout group id collision: shared",
		);
		const unregister = replaceHePiLoadoutGroup(group("shared", "Replacement"), registry);
		unregister();
		expect(registry.get("shared")?.label).toBe("Replacement");
	});

	test("removes factory-time groups on session shutdown", () => {
		const events: Array<() => void> = [];
		const pi = {
			events: createEventBus(),
			on: (_event: "session_shutdown", handler: () => void) => {
				events.push(handler);
			},
		};
		const unregister = registerHePiRuntimeLoadoutGroup(pi, group("factory"));
		const registry = getHePiRuntimeLoadoutGroupRegistry(pi);
		expect(registry.get("factory")).toBeDefined();
		events[0]?.();
		expect(registry.get("factory")).toBeUndefined();
		unregister();
	});
});
