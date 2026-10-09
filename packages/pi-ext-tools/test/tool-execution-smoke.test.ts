import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { registerBashTool } from "../src/bash.js";
import { EvalToolBridge } from "../src/eval/bridge.js";
import { EvalKernelHost } from "../src/eval/kernel/host.js";
import { createEvalRuntimeState, startEvalRuntime } from "../src/eval/lifecycle.js";
import { registerPythonEvalTool } from "../src/eval/tool.js";
import { registerTools } from "../src/tools.js";
import { framedHost, mountTool, toolFor } from "./fixtures/harness.js";

const callId = "smoke-call";

function outputOccurrences(component: ToolExecutionComponent, output: string): number {
	return stripTerminalSequences(component.render(100).join("\n")).split(output).length - 1;
}

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

function _framedBody(component: ToolExecutionComponent): readonly string[] {
	const lines = stripTerminalSequences(component.render(100).join("\n")).split("\n");
	// The last two rails bound the result body: a request section above it closed its own pair.
	const rails = lines.flatMap((line, index) => (line.includes("─") ? [index] : []));
	const opening = rails.at(-2);
	const closing = rails.at(-1);
	return opening === undefined || closing === undefined ? [] : lines.slice(opening + 1, closing);
}

describe("ToolExecutionComponent smoke", () => {
	test("keeps the bash command visible across streamed arguments and execution start", (): void => {
		const { pi, tools: registered } = framedHost();
		registerBashTool(pi, undefined);
		const bash = toolFor(registered, "bash");
		const component = mountTool("bash", "streamed-bash", bash);
		component.render(100);
		component.updateArgs({ command: "printf hello" });
		component.markExecutionStarted();
		expect(stripTerminalSequences(component.render(100).join("\n"))).toContain("printf hello");
	});

	test("renders one persisted eval body after invalidation and resume", async (): Promise<void> => {
		const { pi, tools: registered } = framedHost();
		const state = createEvalRuntimeState();
		const stopRuntime = startEvalRuntime(state, new EvalKernelHost(process.cwd()));
		registerPythonEvalTool(pi, state, new EvalToolBridge(new Map(), () => false));
		const tool = registered[0]!;
		try {
			const component = mountTool("python_eval", callId, tool, { code: "print(40 + 2)" });
			component.markExecutionStarted();
			const result = await tool.execute(callId, { code: "print(40 + 2)" }, undefined, undefined, {
				cwd: process.cwd(),
				sessionManager: { getLeafId: () => null },
			} as never);
			component.updateResult({ ...result, isError: false });
			expect(outputLines(component, "42")).toBe(1);
			component.invalidate();
			component.invalidate();
			expect(outputLines(component, "42")).toBe(1);

			const resumed = mountTool("python_eval", "resumed-eval", tool, { code: "print(40 + 2)" });
			resumed.setExpanded(true);
			resumed.updateResult({ ...result, isError: false });
			expect(outputLines(resumed, "42")).toBe(1);
		} finally {
			stopRuntime();
		}
	});

	test("renders one eval body through partial updates and invalidations", async (): Promise<void> => {
		const { pi, tools: registered } = framedHost();
		const state = createEvalRuntimeState();
		const stopRuntime = startEvalRuntime(state, new EvalKernelHost(process.cwd()));
		registerPythonEvalTool(pi, state, new EvalToolBridge(new Map(), () => false));
		const tool = registered[0]!;
		try {
			const component = mountTool("python_eval", callId, tool, { code: "print(40 + 2)" });
			component.markExecutionStarted();
			let partial: AgentToolResult<unknown> | undefined;
			const final = await tool.execute(
				callId,
				{ code: "print(40 + 2)" },
				undefined,
				(update) => {
					partial = update;
				},
				{ cwd: process.cwd(), sessionManager: { getLeafId: () => null } } as never,
			);
			if (partial === undefined) throw new Error("Expected eval partial output");
			component.updateResult({ ...partial, isError: false }, true);
			expect(outputLines(component, "42")).toBe(1);
			component.updateResult({ ...final, isError: false });
			expect(outputLines(component, "42")).toBe(1);
			component.invalidate();
			component.invalidate();
			expect(outputLines(component, "42")).toBe(1);
		} finally {
			stopRuntime();
		}
	});

	test("renders eval output without a null row for value-less cells", async (): Promise<void> => {
		const { pi, tools: registered } = framedHost();
		const state = createEvalRuntimeState();
		const stopRuntime = startEvalRuntime(state, new EvalKernelHost(process.cwd()));
		registerPythonEvalTool(pi, state, new EvalToolBridge(new Map(), () => false));
		const tool = registered[0]!;
		const render = async (code: string): Promise<string> => {
			const component = mountTool("python_eval", `null-row-${code}`, tool, { code });
			component.markExecutionStarted();
			component.updateResult({
				...(await tool.execute(`null-row-${code}`, { code }, undefined, undefined, {
					cwd: process.cwd(),
					sessionManager: { getLeafId: () => null },
				} as never)),
				isError: false,
			});
			return stripTerminalSequences(component.render(100).join("\n"));
		};
		try {
			// `print` returns None, so the row would read `null` if the kernel reported it.
			const printed = await render('print("NO_NULL_MARKER")');
			expect(printed).toContain("NO_NULL_MARKER");
			expect(printed).not.toContain("null");

			const assigned = await render("x = 5");
			expect(assigned).not.toContain("null");

			// A real value is still reported.
			expect(await render("1 + 1")).toContain("2");
		} finally {
			stopRuntime();
		}
	});

	test("renders one final bash result after partial updates and invalidations", async (): Promise<void> => {
		const { pi, tools: registered } = framedHost();
		registerBashTool(pi, undefined);
		const tool = registered[0]!;
		let requests = 0;
		const ui = {
			requestRender(): void {
				requests += 1;
			},
		} as unknown as TUI;
		const component = mountTool(
			"bash",
			callId,
			tool,
			{ command: "printf BODY_ && printf MARKER", timeout: 20 },
			process.cwd(),
			ui,
		);
		component.markExecutionStarted();
		let partial: AgentToolResult<unknown> | undefined;
		const final = await tool.execute(
			callId,
			{ command: "printf BODY_ && printf MARKER", timeout: 20 },
			undefined,
			(update) => {
				partial = update;
			},
			{ cwd: process.cwd(), sessionManager: { getLeafId: () => null } } as never,
		);
		if (partial === undefined) throw new Error("Expected bash partial output");
		component.updateResult({ ...partial, isError: false }, true);
		expect(outputOccurrences(component, "BODY_MARKER")).toBe(1);

		component.updateResult({ ...final, isError: false });
		expect(outputOccurrences(component, "BODY_MARKER")).toBe(1);
		for (let index = 0; index < 3; index += 1) {
			component.invalidate();
			expect(outputOccurrences(component, "BODY_MARKER")).toBe(1);
		}
		await Promise.resolve();
		expect(outputOccurrences(component, "BODY_MARKER")).toBe(1);
		expect(requests).toBeGreaterThan(0);
	});

	test("keeps ten complete bash output rows in the host body", async (): Promise<void> => {
		const { pi, tools: registered } = framedHost();
		registerBashTool(pi, undefined);
		const tool = registered[0]!;
		const component = mountTool("bash", "complete-bash-body", tool, { command: "printf many" });
		component.markExecutionStarted();
		const command = "i=1; while [ $i -le 30 ]; do echo line $i; i=$((i + 1)); done";
		let partial: AgentToolResult<unknown> | undefined;
		const result = await tool.execute(
			"complete-bash-body",
			{ command },
			undefined,
			(update) => {
				partial = update;
				component.updateResult({ ...update, isError: false }, true);
			},
			{ cwd: process.cwd(), sessionManager: { getLeafId: () => null } } as never,
		);
		if (partial === undefined) throw new Error("Expected bash partial output");
		component.updateResult({ ...result, isError: false });
		const rendered = stripTerminalSequences(component.render(100).join("\n"));
		expect(rendered).toMatch(/… \(21 earlier lines,/);
		expect(rendered).toContain("line 30");
	});

	test("keeps native write preview body after final host completion", async (): Promise<void> => {
		const cwd = await mkdtemp(join(tmpdir(), "hepi-native-write-smoke-"));
		const { pi, tools: registered } = framedHost();
		registerTools(pi);
		const tool = toolFor(registered, "write");
		const component = mountTool(
			"write",
			"native-write-body",
			tool,
			{ path: "value.ts", content: "alpha\nbeta\n" },
			cwd,
		);
		component.markExecutionStarted();
		const result = await tool.execute(
			"native-write-body",
			{ path: "value.ts", content: "alpha\nbeta\n" },
			undefined,
			undefined,
			{ cwd } as never,
		);
		component.updateResult({ ...result, isError: false });
		const rendered = stripTerminalSequences(component.render(100).join("\n"));
		expect(rendered).toContain("Successfully wrote to value.ts");
		await rm(cwd, { recursive: true, force: true });
	});

	test("renders SSH write headers and Unconfirmed recovery through the host", (): void => {
		const { pi, tools: registered } = framedHost();
		registerTools(pi);
		const tool = toolFor(registered, "write");
		const component = mountTool("write", "ssh-write-unconfirmed", tool, {
			path: "value.ts",
			content: "next\n",
			target: "ileqm",
		});
		component.markExecutionStarted();
		component.updateResult({
			content: [{ type: "text", text: "Remote outcome is unknown" }],
			details: {
				__piExtToolsRemoteMutation: {
					target: "ileqm",
					path: "value.ts",
					outcome: "unconfirmed",
					error: "rename acknowledgement was lost",
				},
			},
			isError: true,
		});
		for (let index = 0; index < 3; index += 1) {
			const rendered = stripTerminalSequences(component.render(100).join("\n"));
			expect(rendered).toContain("󰘥 ileqm:value.ts");
			component.invalidate();
		}
	});

	test("draws a NotApplied remote mutation with the shared outcome glyph", (): void => {
		const { pi, tools: registered } = framedHost();
		registerTools(pi);
		for (const toolName of ["write", "edit"]) {
			const tool = toolFor(registered, toolName);
			const component = mountTool(toolName, `ssh-${toolName}-not-applied`, tool, {
				path: "value.ts",
				content: "next\n",
				oldText: "alpha",
				newText: "next",
				target: "ileqm",
			});
			component.markExecutionStarted();
			component.updateResult({
				content: [{ type: "text", text: "Remote write failed" }],
				details: {
					__piExtToolsRemoteMutation: {
						target: "ileqm",
						path: "value.ts",
						outcome: "not_applied",
						error: "the write failed before publish",
					},
				},
				isError: true,
			});
			const rendered = stripTerminalSequences(component.render(100).join("\n"));
			expect(rendered).toContain("󰍷 ileqm:value.ts · the write failed before publish");
			expect(rendered).not.toContain("– ");
		}
	});
});
