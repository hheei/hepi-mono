import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLoadoutInventory,
	createLoadoutInventoryProvider,
	createMcpPlaceholder,
	mergeLoadoutInventory,
} from "../../../src/loadout/inventory.js";

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

	test("loads skill instructions asynchronously and refreshes a changed skill file", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-basics-skill-cache-"));
		const path = join(directory, "SKILL.md");
		writeFileSync(path, "---\nname: demo\n---\n\nFirst instruction.\n");
		try {
			const provider = createLoadoutInventoryProvider({
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
			const first = await provider.load();
			writeFileSync(path, "---\nname: demo\n---\n\nChanged instruction.\n");
			const second = await provider.load();
			const firstItems = "items" in first ? first.items : first;
			const secondItems = "items" in second ? second.items : second;
			expect(firstItems[0]?.instruction).toBe("First instruction.");
			expect(secondItems[0]?.instruction).toBe("Changed instruction.");
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

	test("uses module-selected groups and keeps unselected tools on automatic groups", () => {
		const inventory = createLoadoutInventory({
			getLoadoutGroups: () => [
				{ id: "module", label: "Module tools", items: ["selected", "tool:pkg:exact"] },
			],
			getAllTools: () => [
				{
					name: "selected",
					description: "Selected",
					parameters: {},
					sourceInfo: { scope: "project", source: "pkg", path: "p", origin: "package" },
				},
				{
					name: "other",
					description: "Other",
					parameters: {},
					sourceInfo: { scope: "project", source: "pkg", path: "p", origin: "package" },
				},
			],
		});

		expect(inventory.items.find((item) => item.name === "selected")?.group).toBe("Module tools");
		expect(inventory.items.find((item) => item.name === "other")?.group).toBeUndefined();
	});

	test("matches an exact Loadout key when tools share a name", () => {
		const inventory = createLoadoutInventory({
			getLoadoutGroups: () => [{ id: "module", label: "Module tools", items: ["tool:one:shared"] }],
			getAllTools: () => [
				{
					name: "shared",
					description: "One",
					parameters: {},
					sourceInfo: { scope: "user", source: "one", path: "one", origin: "package" },
				},
				{
					name: "shared",
					description: "Two",
					parameters: {},
					sourceInfo: { scope: "user", source: "two", path: "two", origin: "package" },
				},
			],
		});

		expect(inventory.items.find((item) => item.key === "tool:one:shared")?.group).toBe(
			"Module tools",
		);
		expect(inventory.items.find((item) => item.key === "tool:two:shared")?.group).toBeUndefined();
	});
});
