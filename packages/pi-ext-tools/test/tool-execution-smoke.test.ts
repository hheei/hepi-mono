import { describe, expect, test } from "bun:test";
import {
	type ExtensionAPI,
	initTheme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { registerApplyPatchTool } from "../dist/apply-patch-tool.js";
import { registerBashTool } from "../dist/bash.js";
import { ToolTraceController } from "../dist/pretty/trace.js";

const callId = "smoke-call";

function outputOccurrences(component: ToolExecutionComponent, output: string): number {
	return stripTerminalSequences(component.render(100).join("\n")).split(output).length - 1;
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

	test("renders apply_patch operation rows during partial progress", (): void => {
		initTheme("dark");
		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool(tool: ToolDefinition): void {
				registered.push(tool);
			},
		} as unknown as ExtensionAPI;
		const trace = new ToolTraceController();
		registerApplyPatchTool(pi, trace);
		const tool = registered[0]!;
		const ui = { requestRender: (): void => undefined } as unknown as TUI;
		trace.startTrace();
		trace.begin(callId);
		const component = new ToolExecutionComponent(
			"apply_patch",
			callId,
			{ patch: "*** Begin Patch\n*** End Patch" },
			undefined,
			tool,
			ui,
			process.cwd(),
		);
		component.markExecutionStarted();
		const partial = {
			content: [],
			details: {
				changedPaths: [],
				addedLines: 3,
				removedLines: 2,
				operations: [
					{
						operationIndex: 0,
						kind: "update" as const,
						path: "src/stream.ts",
						addedLines: 3,
						removedLines: 2,
						status: "pending" as const,
					},
				],
				operationCount: 1,
				exactUpdateCount: 0,
				fuzzyUpdateCount: 0,
				applied: [],
				rejected: [],
				status: "success" as const,
				progress: { files: 1, addedLines: 3, removedLines: 2, operations: [] },
			},
		};
		trace.update(callId, partial);
		component.updateResult({ ...partial, isError: false }, true);
		const partialText = stripTerminalSequences(component.render(100).join("\n"));
		expect(partialText).toContain("modify src/stream.ts +3 -2");
		expect(outputOccurrences(component, "modify src/stream.ts +3 -2")).toBe(1);

		const final = {
			...partial,
			details: {
				...partial.details,
				operations: [{ ...partial.details.operations[0]!, status: "applied" as const }],
			},
		};
		trace.complete(callId);
		component.updateResult({ ...final, isError: false });
		const finalText = stripTerminalSequences(component.render(100).join("\n"));
		expect(finalText).toContain("✓ modify src/stream.ts +3 -2");
		expect(outputOccurrences(component, "modify src/stream.ts +3 -2")).toBe(1);
	});
});
