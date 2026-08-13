import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolResult,
	type ExtensionAPI,
	initTheme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerApplyPatchTool } from "../dist/apply-patch-tool.js";
import { registerBashTool } from "../dist/bash.js";
import { createToolTui } from "../dist/pretty/frame.js";

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
		const tui = createToolTui();
		registerBashTool(pi, undefined, tui);
		const tool = registered[0]!;
		let requests = 0;
		const ui = {
			requestRender(): void {
				requests += 1;
			},
		} as unknown as TUI;
		tui.beginTrace();
		const component = new ToolExecutionComponent(
			"bash",
			callId,
			{ command: "printf BODY_ && printf MARKER", timeout: 20 },
			undefined,
			tool,
			ui,
			process.cwd(),
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
			{ cwd: process.cwd() } as never,
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

	test("omits bash body rails when the host receives zero output lines", async (): Promise<void> => {
		initTheme("dark");
		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool(tool: ToolDefinition): void {
				registered.push(tool);
			},
		} as unknown as ExtensionAPI;
		const tui = createToolTui();
		registerBashTool(pi, undefined, tui);
		const tool = registered[0]!;
		const ui = { requestRender: (): void => undefined } as unknown as TUI;
		tui.beginTrace();
		const component = new ToolExecutionComponent(
			"bash",
			callId,
			{ command: "true" },
			undefined,
			tool,
			ui,
			process.cwd(),
		);
		component.markExecutionStarted();
		const result = await tool.execute(callId, { command: "true" }, undefined, undefined, {
			cwd: process.cwd(),
		} as never);
		component.updateResult({ ...result, isError: false });
		for (let index = 0; index < 3; index += 1) {
			const rendered = stripTerminalSequences(component.render(100).join("\n"));
			expect(rendered).toContain("exit 0 · 0 lines");
			expect(rendered).not.toContain("─");
			component.invalidate();
		}
	});

	test("renders one body on the first resumed result pass", (): void => {
		initTheme("dark");
		const tui = createToolTui();
		const Params = Type.Object({ path: Type.String() });
		const tool = tui.frame({
			name: "resume_body",
			label: "resume_body",
			description: "Synthetic resumed tool",
			parameters: Params,
			execute: async () => ({ content: [], details: undefined }),
			renderCall: () => new Text("call preview", 0, 0),
			renderResult: () => new Text("restored body", 0, 0),
		});
		const ui = { requestRender: (): void => undefined } as unknown as TUI;
		tui.beginTrace();
		const component = new ToolExecutionComponent(
			"resume_body",
			"resumed-call",
			{ path: "src/resumed.ts" },
			undefined,
			tool,
			ui,
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [], details: undefined, isError: false });
		const rendered = stripTerminalSequences(component.render(100).join("\n"));
		expect(rendered).toContain("restored body");
		expect(rendered).not.toContain("call preview");
		expect(rendered.match(/─/g)).toHaveLength(200);
	});

	test("renders ToolTui body rows once through partial and final host updates", async (): Promise<void> => {
		initTheme("dark");
		const tui = createToolTui();
		const Params = Type.Object({ path: Type.String() });
		const tool = tui.frame(
			{
				name: "synthetic_patch",
				label: "synthetic_patch",
				description: "Synthetic host lifecycle tool",
				parameters: Params,
				async execute(_id, _params, _signal, onUpdate) {
					onUpdate?.({ content: [], details: { row: "modify src/stream.ts +3 -2" } });
					return { content: [], details: { row: "✓ modify src/stream.ts +3 -2" } };
				},
				renderResult(result) {
					return new Text((result.details as { row: string }).row, 0, 0);
				},
			},
			{
				summary: () => "1 files",
				footer: () => "+3 -2 lines",
			},
		);
		const ui = { requestRender: (): void => undefined } as unknown as TUI;
		tui.beginTrace();
		const component = new ToolExecutionComponent(
			"synthetic_patch",
			callId,
			{ path: "src/stream.ts" },
			undefined,
			tool,
			ui,
			process.cwd(),
		);
		component.markExecutionStarted();
		let partial: AgentToolResult<unknown> | undefined;
		const final = await tool.execute(
			callId,
			{ path: "src/stream.ts" },
			undefined,
			(update) => {
				partial = update;
			},
			{ cwd: process.cwd() } as never,
		);
		if (partial === undefined) throw new Error("Expected synthetic partial output");
		component.updateResult({ ...partial, isError: false }, true);
		const partialText = stripTerminalSequences(component.render(100).join("\n"));
		expect(partialText).toContain("synthetic_patch · 1 files");
		expect(outputOccurrences(component, "modify src/stream.ts +3 -2")).toBe(1);

		component.updateResult({ ...final, isError: false });
		for (let index = 0; index < 3; index += 1) {
			const finalText = stripTerminalSequences(component.render(100).join("\n"));
			expect(finalText).toContain("+3 -2 lines");
			expect(finalText).toContain("✓ modify src/stream.ts +3 -2");
			expect(outputOccurrences(component, "modify src/stream.ts +3 -2")).toBe(1);
			component.invalidate();
		}
	});

	test("renders real apply_patch progress before its execution completes", async (): Promise<void> => {
		initTheme("dark");
		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool(tool: ToolDefinition): void {
				registered.push(tool);
			},
		} as unknown as ExtensionAPI;
		const tui = createToolTui();
		registerApplyPatchTool(pi, tui);
		const tool = registered[0];
		if (tool === undefined) throw new Error("apply_patch was not registered");
		const ui = { requestRender: (): void => undefined } as unknown as TUI;
		const root = await mkdtemp(join(tmpdir(), "hepi-apply-patch-host-stream-"));
		try {
			tui.beginTrace();
			const component = new ToolExecutionComponent(
				"apply_patch",
				"apply-patch-stream",
				{
					patch:
						"*** Begin Patch\n*** Add File: first.txt\n+one\n*** Add File: second.txt\n+two\n*** End Patch",
				},
				undefined,
				tool,
				ui,
				root,
			);
			component.markExecutionStarted();
			let resolveFirstUpdate: (() => void) | undefined;
			const firstUpdate = new Promise<void>((resolve) => {
				resolveFirstUpdate = resolve;
			});
			let resolveCommittedUpdate: (() => void) | undefined;
			const committedUpdate = new Promise<void>((resolve) => {
				resolveCommittedUpdate = resolve;
			});
			let settled = false;
			const execution = tool.execute(
				"apply-patch-stream",
				{
					patch:
						"*** Begin Patch\n*** Add File: first.txt\n+one\n*** Add File: second.txt\n+two\n*** End Patch",
				},
				undefined,
				(update) => {
					component.updateResult({ ...update, isError: false }, true);
					resolveFirstUpdate?.();
					resolveFirstUpdate = undefined;
					if (
						typeof update.details === "object" &&
						update.details !== null &&
						"progress" in update.details &&
						typeof update.details.progress === "object" &&
						update.details.progress !== null &&
						"stage" in update.details.progress &&
						update.details.progress.stage === "committed"
					) {
						resolveCommittedUpdate?.();
						resolveCommittedUpdate = undefined;
					}
				},
				{ cwd: root } as never,
			);
			void execution.finally(() => {
				settled = true;
			});
			await firstUpdate;
			const partialText = stripTerminalSequences(component.render(100).join("\n"));
			expect(settled).toBe(false);
			expect(partialText).toContain("apply_patch 1 files");
			expect(partialText).toContain("○ create first.txt +1");
			await committedUpdate;
			expect(settled).toBe(false);
			expect(stripTerminalSequences(component.render(100).join("\n"))).toContain(
				"✓ create first.txt +1",
			);
			const result = await execution;
			component.updateResult({ ...result, isError: false });
			expect(stripTerminalSequences(component.render(100).join("\n"))).toContain(
				"✓ create first.txt +1",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
