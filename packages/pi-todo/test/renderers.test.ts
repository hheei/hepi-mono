import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { registerExtensionHook, type ToolRenderers, toolRendererPoint } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import { createTodoFeature, TODO_TOOL_NAME } from "../src/todo.js";
import { plainTheme } from "./fixtures/theme.js";

interface TodoTool {
	readonly name: string;
	readonly defaultActive?: boolean;
	readonly renderShell?: "default" | "self";
	renderCall(args: unknown, theme: Theme, context: { isError: boolean }): Component;
	renderResult(
		result: { readonly content?: readonly unknown[]; readonly details?: unknown },
		options: { expanded?: boolean },
		theme: Theme,
		context: { isError: boolean },
	): Component;
}

/** A pi double without an event bus keeps ext-core hook state scoped to this runtime. */
function piDouble(): { readonly pi: ExtensionAPI; readonly tools: TodoTool[] } {
	const tools: TodoTool[] = [];
	const pi = {
		registerTool(tool: TodoTool) {
			tools.push(tool);
		},
		registerCommand() {},
		getActiveTools: () => [TODO_TOOL_NAME],
		appendEntry() {},
		on() {},
	} as unknown as ExtensionAPI;
	createTodoFeature(pi);
	return { pi, tools };
}

function rows(value: Component): string[] {
	return [...value.render(120)].map((line) => line.trimEnd()).filter((line) => line !== "");
}

function tool(): TodoTool {
	const registered = piDouble().tools[0];
	if (registered === undefined) throw new Error("todo tool was not registered");
	return registered;
}

const createResult = {
	content: [{ type: "text", text: "Created #1\nin_progress: #1 First." }],
	details: {
		snapshot: { tasks: [{ id: 1, subject: "First", status: "in_progress" }], nextId: 2 },
		operations: [{ index: 0, action: "create", changed: true, id: 1 }],
	},
};

describe("todo optional renderers", () => {
	test("owns a self-framed native definition without any UI package", () => {
		const registered = tool();
		expect(registered.name).toBe("todo");
		expect(registered.renderShell).toBe("self");
		expect(registered.defaultActive).toBe(false);
		expect(rows(registered.renderCall({ operations: [] }, plainTheme, { isError: false }))).toEqual(
			["todo"],
		);
		expect(
			rows(registered.renderResult(createResult, {}, plainTheme, { isError: false })).join("\n"),
		).toContain("#1 First");
		expect(
			rows(
				registered.renderResult(
					{ content: [{ type: "text", text: "Task #9 does not exist." }] },
					{},
					plainTheme,
					{ isError: true },
				),
			),
		).toEqual(["Task #9 does not exist."]);
	});

	test("native call frame lists the requested operations and task ids", () => {
		expect(
			rows(
				tool().renderCall(
					{
						operations: [
							{ action: "create", subject: "Inspect output" },
							{ action: "update", id: 2, status: "blocked" },
							{ action: "delete", id: "3" },
							{ action: "list", status: "pending" },
						],
					},
					plainTheme,
					{ isError: false },
				),
			),
		).toEqual(["todo", "+ Inspect output", "~ #2", "- #3", "list pending"]);
	});

	test("native call frame bounds long batches and tolerates malformed arguments", () => {
		const registered = tool();
		const operations = Array.from({ length: 11 }, (_unused, index) => ({
			action: "update",
			id: index + 1,
			status: "completed",
		}));
		const shown = rows(registered.renderCall({ operations }, plainTheme, { isError: false }));
		expect(shown[0]).toBe("todo");
		expect(shown[1]).toBe("~ #1");
		expect(shown.at(-1)).toBe("… +3 more");
		expect(shown).toHaveLength(10);
		expect(
			rows(registered.renderCall({ operations: "not-a-list" }, plainTheme, { isError: true })),
		).toEqual(["todo"]);
	});

	test("delegates to a later-loaded UI hook and returns to native after dispose", async () => {
		const { pi, tools } = piDouble();
		const registered = tools[0]!;
		const ui: ToolRenderers = {
			renderCall: () => new Text("ui call", 0, 0) as Component,
			renderResult: () => new Text("ui result", 0, 0) as Component,
		};
		const handle = registerExtensionHook(pi, toolRendererPoint, () => ui);
		expect(rows(registered.renderCall({ operations: [] }, plainTheme, { isError: false }))).toEqual(
			["ui call"],
		);
		expect(rows(registered.renderResult(createResult, {}, plainTheme, { isError: false }))).toEqual(
			["ui result"],
		);

		await handle.dispose();
		expect(rows(registered.renderCall({ operations: [] }, plainTheme, { isError: false }))).toEqual(
			["todo"],
		);
		expect(
			rows(registered.renderResult(createResult, {}, plainTheme, { isError: false })).join("\n"),
		).toContain("#1 First");
	});
});
