import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLoadoutInventory,
	createMcpPlaceholder,
	mergeLoadoutInventory,
} from "../../../src/modules/loadout/inventory.js";

describe("loadout inventory", () => {
	test("maps tools and skill commands to stable keys", () => {
		const inventory = createLoadoutInventory({
			getToolDefinition: (name) => (name === "zeta" ? { promptSnippet: "Run zeta" } : undefined),
			getAllTools: () => [
				{
					name: "zeta",
					description: "Z",
					parameters: {},
					promptGuidelines: ["Use tool carefully."],
					sourceInfo: { scope: "project", source: "pkg", path: "p", origin: "package" },
				},
				{
					name: "bash",
					description: "Bash",
					parameters: {},
					sourceInfo: { scope: "temporary", source: "builtin", path: "p", origin: "top-level" },
				},
				{
					name: "edit",
					description: "Edit",
					parameters: {},
					sourceInfo: { scope: "temporary", source: "builtin", path: "p", origin: "top-level" },
				},
				{
					name: "find",
					description: "Find",
					parameters: {},
					sourceInfo: { scope: "temporary", source: "builtin", path: "p", origin: "top-level" },
				},
				{
					name: "alpha",
					description: "A",
					parameters: {},
					sourceInfo: { scope: "user", source: "core", path: "p", origin: "top-level" },
				},
			],
			getCommands: () => [
				{
					name: "skill:one",
					description: "One",
					source: "skill",
					sourceInfo: { scope: "user", source: "skill", path: "p", origin: "package" },
				},
				{
					name: "other",
					source: "skill",
					sourceInfo: { scope: "user", source: "skill", path: "p", origin: "package" },
				},
			],
		});
		expect(inventory.items.map((item) => item.key)).toEqual([
			"tool:core:alpha",
			"tool:builtin:bash",
			"tool:builtin:edit",
			"tool:builtin:find",
			"tool:pkg:zeta",
			"skill:skill:one",
		]);
		for (const name of ["bash", "edit", "find"]) {
			const item = inventory.items.find((entry) => entry.key === `tool:builtin:${name}`);
			expect(item?.hasGlobalDefinition).toBe(true);
			expect(item?.tokenCount).toBeGreaterThan(0);
		}
		expect(inventory.items.find((item) => item.key === "tool:pkg:zeta")?.hasGlobalDefinition).toBe(
			false,
		);
		expect(inventory.items.find((item) => item.key === "tool:pkg:zeta")?.description).toBe(
			"Run zeta",
		);
		expect(inventory.items.find((item) => item.key === "tool:pkg:zeta")?.instruction).toBe(
			"Use tool carefully.",
		);
	});

	test("uses skill body as instruction and token source", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-basics-skill-"));
		const path = join(directory, "SKILL.md");
		writeFileSync(path, "---\nname: demo\ndescription: Demo\n---\n\nDo this carefully.\n");
		try {
			const inventory = createLoadoutInventory({
				getAllTools: () => [],
				getCommands: () => [
					{
						name: "skill:demo",
						description: "Demo",
						source: "skill",
						sourceInfo: { scope: "user", source: "builtin", path, origin: "top-level" },
					},
				],
			});
			const item = inventory.items[0];
			expect(item?.instruction).toBe("Do this carefully.");
			expect(item?.tokenCount).toBeGreaterThan(2);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("adds MCP placeholders without runtime assumptions", () => {
		const item = createMcpPlaceholder("server", "description");
		const merged = mergeLoadoutInventory({ items: [item] }, [item, createMcpPlaceholder("other")]);
		expect(merged.items.map((entry) => entry.key)).toEqual([
			"mcp:MCP placeholder:other",
			"mcp:MCP placeholder:server",
		]);
	});
});
