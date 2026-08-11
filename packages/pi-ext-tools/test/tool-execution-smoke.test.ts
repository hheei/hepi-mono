import { describe, expect, test } from "bun:test";
import {
	type ExtensionAPI,
	initTheme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { registerBashTool } from "../dist/bash.js";
import { ToolTraceController } from "../dist/pretty/trace.js";

const callId = "smoke-call";

function outputOccurrences(component: ToolExecutionComponent, output: string): number {
	return component.render(100).join("\n").split(output).length - 1;
}

describe("ToolExecutionComponent smoke", () => {
	test("renders one final bash result after partial updates and invalidations", async (): Promise<void> => {
		initTheme("dark");
		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool(tool: ToolDefinition): void {
				registered.push(tool);
			},
		} as unknown as ExtensionAPI;
		const trace = new ToolTraceController();
		registerBashTool(pi, undefined, trace);
		const tool = registered[0]!;
		let requests = 0;
		const ui = {
			requestRender(): void {
				requests += 1;
			},
		} as unknown as TUI;
		trace.startTrace();
		trace.begin(callId);
		const component = new ToolExecutionComponent(
			"bash",
			callId,
			{ command: "printf smoke", timeout: 20 },
			undefined,
			tool,
			ui,
			process.cwd(),
		);
		component.markExecutionStarted();
		const partial = {
			content: [{ type: "text", text: "partial smoke output" }],
			details: { output: "partial smoke output", exitCode: 0 },
		};
		trace.update(callId, partial);
		component.updateResult({ ...partial, isError: false }, true);
		expect(outputOccurrences(component, "partial smoke output")).toBe(1);

		const final = {
			content: [{ type: "text", text: "final smoke output" }],
			details: { output: "final smoke output", exitCode: 0 },
		};
		trace.complete(callId);
		component.updateResult({ ...final, isError: false });
		expect(outputOccurrences(component, "final smoke output")).toBe(1);
		for (let index = 0; index < 3; index += 1) {
			component.invalidate();
			expect(outputOccurrences(component, "final smoke output")).toBe(1);
		}
		await Promise.resolve();
		expect(outputOccurrences(component, "final smoke output")).toBe(1);
		expect(requests).toBeGreaterThan(0);
	});
});
