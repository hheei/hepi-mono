import { describe, expect, test } from "bun:test";
import { createEventBus, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getHepiRuntimeLoadoutGroupRegistry } from "../../hepi-basics/src/core/index.js";
import {
	HEPI_TOOLS_LOADOUT_GROUPS,
	registerHepiToolsLoadoutGroups,
	withHepiToolLoadoutGroup,
} from "../src/loadout-groups.js";

describe("HEPI tools Loadout groups", () => {
	test("registers the external tool groups with fallback items", () => {
		const shutdownHandlers: Array<() => void> = [];
		const pi = {
			events: createEventBus(),
			on: (_event: "session_shutdown", handler: () => void) => shutdownHandlers.push(handler),
		} as never;

		registerHepiToolsLoadoutGroups(pi);
		const registry = getHepiRuntimeLoadoutGroupRegistry(pi);
		expect(registry.list().map((group) => group.id)).toEqual(["fff", "web-search"]);
		expect(registry.list()).toEqual(
			[...HEPI_TOOLS_LOADOUT_GROUPS].sort((a, b) => a.label.localeCompare(b.label)),
		);
		expect(registry.list().find((group) => group.id === "fff")?.items).toContain("find");
		for (const handler of shutdownHandlers) handler();
		expect(registry.list()).toEqual([]);
	});

	test("captures the tools declared by one leaf extension", () => {
		const shutdownHandlers: Array<() => void> = [];
		const registered: string[] = [];
		const pi = {
			events: createEventBus(),
			on: (_event: "session_shutdown", handler: () => void) => shutdownHandlers.push(handler),
			registerTool: (tool: { name: string }) => registered.push(tool.name),
		} as never;

		const extension = withHepiToolLoadoutGroup(
			(leaf) => {
				for (const name of ["find", "grep"]) {
					leaf.registerTool(
						defineTool({
							name,
							label: name,
							description: name,
							parameters: Type.Object({}),
							async execute() {
								return { content: [], details: undefined };
							},
						}),
					);
				}
			},
			{ id: "fff", label: "FFF", items: ["fallback"] },
		);
		extension(pi);

		expect(registered).toEqual(["find", "grep"]);
		expect(getHepiRuntimeLoadoutGroupRegistry(pi).get("fff")?.items).toEqual(["find", "grep"]);
		for (const handler of shutdownHandlers) handler();
	});

	test("includes explicitly related built-in tools with leaf registrations", () => {
		const pi = {
			events: createEventBus(),
			on: () => undefined,
			registerTool: () => undefined,
		} as never;

		withHepiToolLoadoutGroup(
			(leaf) => {
				leaf.registerTool(
					defineTool({
						name: "find_files",
						label: "find_files",
						description: "find_files",
						parameters: Type.Object({}),
						async execute() {
							return { content: [], details: undefined };
						},
					}),
				);
			},
			{ id: "fff", label: "FFF", items: ["find", "find_files"] },
			["find"],
		)(pi);

		expect(getHepiRuntimeLoadoutGroupRegistry(pi).get("fff")?.items).toEqual([
			"find",
			"find_files",
		]);
	});
});
