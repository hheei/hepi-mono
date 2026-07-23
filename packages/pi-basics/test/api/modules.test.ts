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
	test("orders modules by label then id and rejects collisions", () => {
		const registry = createHePiModuleRegistry();
		registerHePiModule(moduleFor("z", "Same"), registry);
		registerHePiModule(moduleFor("a", "Same"), registry);
		registerHePiModule(moduleFor("b", "First"), registry);

		expect(listHePiModules(registry).map((module) => module.id)).toEqual(["b", "a", "z"]);
		expect(() => registerHePiModule(moduleFor("a", "Other"), registry)).toThrow(
			"HePi module id collision: a",
		);
		replaceHePiModule(moduleFor("a", "Replaced"), registry);
		expect(listHePiModules(registry).find((module) => module.id === "a")?.label).toBe("Replaced");
	});
});
