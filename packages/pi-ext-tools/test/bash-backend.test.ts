import { expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerBashTool } from "../src/bash.js";

test("bash executes through Pi host original backend", async (): Promise<void> => {
	const tools: ToolDefinition[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition): void => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	registerBashTool(pi);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");

	const result = await bash.execute(
		"bash-original-backend",
		{ command: "printf restored-backend" },
		new AbortController().signal,
		() => undefined,
		{
			cwd: process.cwd(),
			sessionManager: {
				getSessionId: () => "bash-backend-test",
				getSessionFile: () => undefined,
			},
		} as ExtensionContext,
	);

	expect(result.content).toEqual([{ type: "text", text: "restored-backend" }]);
});

test("bash exposes PTY only in interactive TUI mode", async (): Promise<void> => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	expect(bash.parameters).toMatchObject({
		anyOf: [
			expect.anything(),
			expect.anything(),
			{ properties: { pty: { const: true } }, additionalProperties: false },
		],
	});
	const result = await bash.execute(
		"bash-pty-unavailable",
		{ command: "printf unavailable", pty: true },
		undefined,
		undefined,
		{ cwd: process.cwd(), mode: "print" } as ExtensionContext,
	);
	expect(result).toMatchObject({
		content: [{ type: "text", text: "PTY Bash requires an interactive TUI with PTY enabled" }],
		details: { error: "pty_unavailable" },
	});
});
