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

test("bash never streams Pi host temporary output paths", async (): Promise<void> => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	const updates: unknown[] = [];
	await bash.execute(
		"bash-streamed-path-redaction",
		{ command: "yes x | head -c 1100000" },
		undefined,
		(update): void => {
			updates.push(update);
		},
		{
			cwd: process.cwd(),
			sessionManager: {
				getSessionId: () => "bash-streamed-path-redaction",
				getSessionFile: () => undefined,
			},
		} as ExtensionContext,
	);
	expect(updates.length).toBeGreaterThan(0);
	expect(updates.map((update) => JSON.stringify(update)).join("\n")).not.toContain(
		"fullOutputPath",
	);
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

test("bash exposes only async and PTY use guidance", (): void => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	expect(bash.description).toBe("Run one shell command or short pipeline.");
	expect(bash.promptSnippet).toBe("Run one shell command or short pipeline.");
	expect(bash.promptGuidelines).toEqual([
		"Use `async` only for finite commands that may outlive this tool call.",
		"Use `pty` only for interactive terminal programs such as `sudo` or `ssh`.",
		"NEVER combine `pty` with `async`.",
	]);
});
