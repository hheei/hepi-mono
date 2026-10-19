import {
	type AgentToolResult,
	initTheme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { EvalToolBridge } from "../src/bridge.js";
import { EvalKernelHost } from "../src/kernel/host.js";
import { createEvalRuntimeState, startEvalRuntime } from "../src/lifecycle.js";
import { registerPythonEvalTool } from "../src/tool.js";
import { framedHost } from "./fixtures/harness.js";

const silentUi = { requestRender: (): void => undefined } as unknown as TUI;

/**
 * Counts rendered lines that consist of exactly `output`.
 *
 * Substring counting cannot be used for numeric output: the eval footer renders
 * `<duration>ms`, so an eval that happens to take 42ms makes "42" appear twice without
 * any duplicated body. Loaded machines stretch the cold-kernel startup into the 40ms
 * range, which made that assertion flake.
 */
function outputLines(component: ToolExecutionComponent, output: string): number {
	return stripTerminalSequences(component.render(100).join("\n"))
		.split("\n")
		.filter((line) => line.trim() === output).length;
}

/**
 * A real kernel behind a registered python_eval tool, with the host frame mounted over it.
 * The suite drives rendering, so the kernel is real: the details a component renders are the
 * ones the kernel actually produced.
 */
function evalFrame(): {
	readonly tool: ToolDefinition;
	readonly mount: (code: string, toolCallId?: string) => ToolExecutionComponent;
	readonly execute: (
		code: string,
		onUpdate?: (update: AgentToolResult<unknown>) => void,
	) => Promise<AgentToolResult<unknown>>;
	readonly dispose: () => void;
} {
	const { pi, tools } = framedHost();
	const state = createEvalRuntimeState();
	const stopRuntime = startEvalRuntime(state, new EvalKernelHost(process.cwd()));
	registerPythonEvalTool(pi, state, new EvalToolBridge());
	const tool = tools[0] as ToolDefinition;
	initTheme("dark");
	return {
		tool,
		mount(code: string, toolCallId = "smoke-call"): ToolExecutionComponent {
			const component = new ToolExecutionComponent(
				"python_eval",
				toolCallId,
				{ code },
				undefined,
				tool as never,
				silentUi,
				process.cwd(),
			);
			component.markExecutionStarted();
			return component;
		},
		execute: async (code, onUpdate) =>
			await tool.execute(
				"smoke-call",
				{ code },
				undefined,
				onUpdate as never,
				{ cwd: process.cwd(), sessionManager: { getLeafId: () => null } } as never,
			),
		dispose: stopRuntime,
	};
}

describe("python_eval rendering through the host frame", () => {
	test("renders one persisted body after invalidation and resume", async (): Promise<void> => {
		const frame = evalFrame();
		try {
			const result = await frame.execute("print(40 + 2)");
			const component = frame.mount("print(40 + 2)");
			component.updateResult({ ...result, isError: false });
			expect(outputLines(component, "42")).toBe(1);
			component.invalidate();
			component.invalidate();
			expect(outputLines(component, "42")).toBe(1);

			const resumed = frame.mount("print(40 + 2)", "resumed-eval");
			resumed.setExpanded(true);
			resumed.updateResult({ ...result, isError: false });
			expect(outputLines(resumed, "42")).toBe(1);
		} finally {
			frame.dispose();
		}
	});

	test("renders one body through partial updates and invalidations", async (): Promise<void> => {
		const frame = evalFrame();
		try {
			const component = frame.mount("print(40 + 2)");
			let partial: AgentToolResult<unknown> | undefined;
			const final = await frame.execute("print(40 + 2)", (update) => {
				partial = update;
			});
			if (partial === undefined) throw new Error("Expected eval partial output");
			component.updateResult({ ...partial, isError: false }, true);
			expect(outputLines(component, "42")).toBe(1);
			component.updateResult({ ...final, isError: false });
			expect(outputLines(component, "42")).toBe(1);
			component.invalidate();
			component.invalidate();
			expect(outputLines(component, "42")).toBe(1);
		} finally {
			frame.dispose();
		}
	});

	test("renders a value-less cell without a null row", async (): Promise<void> => {
		const frame = evalFrame();
		const render = async (code: string): Promise<string> => {
			const component = frame.mount(code, `null-row-${code}`);
			component.updateResult({ ...(await frame.execute(code)), isError: false });
			return stripTerminalSequences(component.render(100).join("\n"));
		};
		try {
			// `print` returns None, so the row would read `null` if the kernel reported it.
			const printed = await render('print("NO_NULL_MARKER")');
			expect(printed).toContain("NO_NULL_MARKER");
			expect(printed).not.toContain("null");

			expect(await render("x = 5")).not.toContain("null");
			// A real value is still reported.
			expect(await render("1 + 1")).toContain("2");
		} finally {
			frame.dispose();
		}
	});
});
