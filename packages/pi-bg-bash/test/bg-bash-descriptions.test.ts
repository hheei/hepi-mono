import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { registerBgBashTools } from "../src/bg-bash-tools.js";
import { createBashRuntime } from "../src/session-state.js";

describe("background Bash tool descriptions", () => {
	test("keeps usage guidance in descriptions without changing system rules", (): void => {
		const tools: ToolDefinition[] = [];
		registerBgBashTools(
			{
				registerTool(tool: ToolDefinition): void {
					tools.push(tool);
				},
			} as unknown as ExtensionAPI,
			createBashRuntime().state,
		);
		expect(tools.find((tool) => tool.name === "bg_bash_get")?.promptGuidelines).toBeUndefined();
		expect(tools.find((tool) => tool.name === "bg_bash_stop")?.promptGuidelines).toBeUndefined();
		expect(tools.find((tool) => tool.name === "bg_bash_get")?.description).toContain(
			"Inspect background Bash runtime",
		);
		expect(tools.find((tool) => tool.name === "bg_bash_stop")?.description).toContain(
			"Stop one background Bash process tree",
		);
	});
});
