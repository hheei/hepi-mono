import { describe, expect, test } from "bun:test";
import {
	createHePiModuleRegistry,
	type HePiModule,
	listHePiModules,
	registerHePiModule,
	replaceHePiModule,
} from "../../src/api/index.js";

const moduleFor = (id: string, label: string): HePiModule => ({
	id,
	label,
	commands: [],
	open: async () => {},
});

describe("HePi module registry", () => {
	test("orders modules, rejects collisions, and disposes its registration", () => {
		const registry = createHePiModuleRegistry();
		registerHePiModule(moduleFor("z", "Same"), registry);
		registerHePiModule(moduleFor("a", "Same"), registry);
		const owned = moduleFor("b", "First");
		const unregister = registerHePiModule(owned, registry);

		expect(listHePiModules(registry).map((module) => module.id)).toEqual(["b", "a", "z"]);
		expect(() => registerHePiModule(moduleFor("a", "Other"), registry)).toThrow(
			"HePi module id collision: a",
		);
		const unregisterReplacement = replaceHePiModule(moduleFor("a", "Replaced"), registry);
		expect(listHePiModules(registry).find((module) => module.id === "a")?.label).toBe("Replaced");
		unregisterReplacement();
		unregister();
		const unregisterAgain = registerHePiModule(owned, registry);
		unregister();
		expect(listHePiModules(registry).map((module) => module.id)).toEqual(["b", "z"]);
		unregisterAgain();
		unregisterAgain();
		expect(listHePiModules(registry).map((module) => module.id)).toEqual(["z"]);
	});
});
