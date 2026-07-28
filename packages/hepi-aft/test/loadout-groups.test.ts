import { describe, expect, test } from "bun:test";
import { HEPI_AFT_LOADOUT_GROUPS } from "../src/extension.js";

describe("AFT Loadout groups", () => {
	test("keeps Pi replacements in built-in and AFT-only tools separate", () => {
		expect(HEPI_AFT_LOADOUT_GROUPS).toEqual([
			{ id: "aft-builtins", label: "built-in", items: ["read", "write", "edit", "bash"] },
			{
				id: "aft",
				label: "AFT",
				items: [
					"apply_patch",
					"bash_status",
					"bash_watch",
					"bash_write",
					"bash_kill",
					"aft_outline",
					"aft_zoom",
					"aft_safety",
					"aft_callgraph",
					"aft_refactor",
					"aft_import",
					"aft_inspect",
				],
			},
		]);
	});
});
