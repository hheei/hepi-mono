import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { registerBashTool } from "../src/bash.js";
import { registerTools } from "../src/tools.js";
import { framedHost, mountTool, toolFor } from "./fixtures/harness.js";

const callId = "smoke-call";

function outputOccurrences(component: ToolExecutionComponent, output: string): number {
	return stripTerminalSequences(component.render(100).join("\n")).split(output).length - 1;
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
});
