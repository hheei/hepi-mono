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
