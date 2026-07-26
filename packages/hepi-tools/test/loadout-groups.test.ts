import { describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { getHePiRuntimeLoadoutGroupRegistry } from "../../hepi-basics/src/core/index.js";
import {
	HEPI_TOOLS_LOADOUT_GROUPS,
	registerHePiToolsLoadoutGroups,
} from "../src/loadout-groups.js";

describe("HEPI tools Loadout groups", () => {
	test("registers the external tool groups with explicit items", () => {
		const shutdownHandlers: Array<() => void> = [];
		const pi = {
			events: createEventBus(),
			on: (_event: "session_shutdown", handler: () => void) => shutdownHandlers.push(handler),
		} as never;

		registerHePiToolsLoadoutGroups(pi);
		const registry = getHePiRuntimeLoadoutGroupRegistry(pi);
		expect(registry.list().map((group) => group.id)).toEqual([
			"fff",
			"magic-context",
			"web-search",
		]);
		expect(registry.list()).toEqual(
			[...HEPI_TOOLS_LOADOUT_GROUPS].sort((a, b) => a.label.localeCompare(b.label)),
		);
		for (const handler of shutdownHandlers) handler();
		expect(registry.list()).toEqual([]);
	});
});
