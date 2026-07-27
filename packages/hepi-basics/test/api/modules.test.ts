import { describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	createHepiModuleRegistry,
	getHepiRuntimeModuleRegistry,
	type HepiModule,
	listHepiModules,
	registerHepiModule,
	replaceHepiModule,
} from "../../src/core/api/index.js";

const moduleFor = (id: string, label: string): HepiModule => ({
	id,
	label,
	commands: [],
	open: async () => {},
});

describe("HePi module registry", () => {
	test("isolates live runtime registries", () => {
		const first = getHepiRuntimeModuleRegistry({ events: createEventBus() });
		const second = getHepiRuntimeModuleRegistry({ events: createEventBus() });
		const unregisterFirst = first.register(moduleFor("shared", "First"));
		second.register(moduleFor("shared", "Second"));

		expect(first.get("shared")?.label).toBe("First");
		expect(second.get("shared")?.label).toBe("Second");
		unregisterFirst();
		expect(first.get("shared")).toBeUndefined();
		expect(second.get("shared")?.label).toBe("Second");
	});

	test("orders modules, rejects collisions, and disposes its registration", () => {
		const registry = createHepiModuleRegistry();
		registerHepiModule(moduleFor("z", "Same"), registry);
		registerHepiModule(moduleFor("a", "Same"), registry);
		const owned = moduleFor("b", "First");
		const unregister = registerHepiModule(owned, registry);

		expect(listHepiModules(registry).map((module) => module.id)).toEqual(["b", "a", "z"]);
		expect(() => registerHepiModule(moduleFor("a", "Other"), registry)).toThrow(
			"HePi module id collision: a",
		);
		const unregisterReplacement = replaceHepiModule(moduleFor("a", "Replaced"), registry);
		expect(listHepiModules(registry).find((module) => module.id === "a")?.label).toBe("Replaced");
		unregisterReplacement();
		unregister();
		const unregisterAgain = registerHepiModule(owned, registry);
		unregister();
		expect(listHepiModules(registry).map((module) => module.id)).toEqual(["b", "z"]);
		unregisterAgain();
		unregisterAgain();
		expect(listHepiModules(registry).map((module) => module.id)).toEqual(["z"]);
	});
});
