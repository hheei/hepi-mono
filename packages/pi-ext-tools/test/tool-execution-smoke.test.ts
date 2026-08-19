import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type ExtensionAPI,
	initTheme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";
import { createToolTui } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { registerApplyPatchTool } from "../dist/apply-patch-tool.js";
import { registerBashTool } from "../dist/bash.js";
import { registerTools } from "../dist/tools.js";

const callId = "smoke-call";

function outputOccurrences(component: ToolExecutionComponent, output: string): number {
	return stripTerminalSequences(component.render(100).join("\n")).split(output).length - 1;
}

function framedBody(component: ToolExecutionComponent): readonly string[] {
	const lines = stripTerminalSequences(component.render(100).join("\n")).split("\n");
	const openingRail = lines.findIndex((line) => line.includes("─"));
	const closingRail = lines.findIndex((line, index) => index > openingRail && line.includes("─"));
	return openingRail < 0 || closingRail < 0 ? [] : lines.slice(openingRail + 1, closingRail);
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

	test("keeps twenty complete bash output rows in the host body", async (): Promise<void> => {
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
		tui.beginTrace();
		const component = new ToolExecutionComponent(
			"bash",
			"complete-bash-body",
			{ command: "printf many" },
			undefined,
			tool,
			{ requestRender: (): void => undefined } as unknown as TUI,
			process.cwd(),
		);
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
			{ cwd: process.cwd() } as never,
		);
		if (partial === undefined) throw new Error("Expected bash partial output");
		component.updateResult({ ...result, isError: false });
		const body = framedBody(component);
		expect(body, stripTerminalSequences(component.render(100).join("\n"))).toHaveLength(20);
		expect(body[0]).toMatch(/^… \(11 earlier lines,/);
		expect(body.at(-1)).toContain("line 30");
	});

	test("keeps native write preview body after final host completion", async (): Promise<void> => {
		initTheme("dark");
		const cwd = await mkdtemp(join(tmpdir(), "hepi-native-write-smoke-"));
		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool(tool: ToolDefinition): void {
				registered.push(tool);
			},
			on(): void {},
		} as unknown as ExtensionAPI;
		const tui = createToolTui();
		registerTools(pi, undefined, tui);
		const tool = registered.find((candidate) => candidate.name === "write");
		if (tool === undefined) throw new Error("write tool was not registered");
		tui.beginTrace();
		const component = new ToolExecutionComponent(
			"write",
			"native-write-body",
			{ path: "value.ts", content: "alpha\nbeta\n" },
			undefined,
			tool,
			{ requestRender: (): void => undefined } as unknown as TUI,
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
		expect(rendered).toContain("alpha");
		expect(rendered).toContain("beta");
		expect(rendered).toContain("11 bytes · 2 lines");
		expect(outputOccurrences(component, "write")).toBe(1);
		await rm(cwd, { recursive: true, force: true });
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

	test("renders a legacy Pi edit patch on the first resumed host pass", (): void => {
		initTheme("dark");
		const registered: ToolDefinition[] = [];
		const pi = {
			events: {},
			registerTool(tool: ToolDefinition): void {
				registered.push(tool);
			},
			on(): void {},
		} as unknown as ExtensionAPI;
		const tui = createToolTui();
		registerTools(pi, undefined, tui);
		const tool = registered.find((candidate) => candidate.name === "edit");
		if (tool === undefined) throw new Error("edit tool was not registered");
		tui.beginTrace();
		const component = new ToolExecutionComponent(
			"edit",
			"resumed-legacy-edit",
			{
				path: "value.ts",
				edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }],
			},
			undefined,
			tool,
			{ requestRender: (): void => undefined } as unknown as TUI,
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({
			content: [{ type: "text", text: "Successfully replaced text." }],
			details: {
				patch: [
					"--- value.ts",
					"+++ value.ts",
					"@@ -41,3 +41,3 @@",
					" const keep = true;",
					"-const before = 1;",
					"+const after = 2;",
					" export { keep };",
				].join("\n"),
			},
			isError: false,
		});
		const rendered = stripTerminalSequences(component.render(100).join("\n"));
		expect(rendered).toContain("edit value.ts");
		expect(rendered).toContain("42- │ const before = 1;");
		expect(rendered).toContain("42+ │ const after = 2;");
		expect(rendered).not.toContain("Successfully replaced text.");
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

	test("renders apply_patch rows from toolcall_delta arguments before execute starts", async (): Promise<void> => {
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
		const root = await mkdtemp(join(tmpdir(), "hepi-apply-patch-delta-"));
		try {
			tui.beginTrace();
			const component = new ToolExecutionComponent(
				"apply_patch",
				"apply-patch-delta",
				{ patch: "*** Begin Patch\n" },
				undefined,
				tool,
				{ requestRender: (): void => undefined } as unknown as TUI,
				root,
			);
			expect(stripTerminalSequences(component.render(100).join("\n"))).not.toContain("create");
			component.updateArgs({ patch: "*** Begin Patch\n*** Add File: first.txt\n" });
			const afterHeader = stripTerminalSequences(component.render(100).join("\n"));
			expect(afterHeader).toContain("apply_patch 1 file");
			expect(afterHeader).toContain("○ create first.txt");
			component.updateArgs({
				patch: "*** Begin Patch\n*** Add File: first.txt\n+one\n*** Add File: second.txt\n",
			});
			const afterPayload = stripTerminalSequences(component.render(100).join("\n"));
			expect(afterPayload).toContain("○ create first.txt +1");
			expect(afterPayload).toContain("○ create second.txt");
			expect(outputOccurrences(component, "○ create first.txt +1")).toBe(1);
			expect(await readdir(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
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
			expect(partialText).toContain("apply_patch 1 file");
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

	test("streams apply_patch through the Pi agent event lifecycle before completion", async (): Promise<void> => {
		initTheme("dark");
		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool(tool: ToolDefinition): void {
				registered.push(tool);
			},
		} as unknown as ExtensionAPI;
		const tui = createToolTui();
		registerApplyPatchTool(pi, tui);
		const definition = registered[0];
		if (definition === undefined) throw new Error("apply_patch was not registered");
		const root = await mkdtemp(join(tmpdir(), "hepi-apply-patch-agent-stream-"));
		try {
			// Pi wraps registered definitions before Agent execution to supply ExtensionContext.
			// Keep the Agent's native four-argument execute path intact for this smoke.
			const tool = {
				...definition,
				execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: never) =>
					definition.execute(toolCallId, params, signal, onUpdate, { cwd: root } as never),
			};
			const patch =
				"*** Begin Patch\n*** Add File: first.txt\n+one\n*** Add File: second.txt\n+two\n*** End Patch";
			const assistant = (content: unknown[], stopReason: "stop" | "toolUse") =>
				({
					role: "assistant",
					content,
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
					stopReason,
					timestamp: Date.now(),
				}) as never;
			let responses = 0;
			const agent = new Agent({
				initialState: {
					model: { api: "test", provider: "test", id: "test" } as never,
					thinkingLevel: "off",
					tools: [tool] as never,
				},
				toolExecution: "sequential",
				streamFn: () => {
					const stream = createAssistantMessageEventStream();
					responses += 1;
					if (responses === 1) {
						const toolCall = {
							type: "toolCall" as const,
							id: "agent-apply-patch",
							name: "apply_patch",
							arguments: { patch },
						};
						const message = assistant([toolCall], "toolUse");
						stream.push({ type: "start", partial: message });
						stream.push({
							type: "toolcall_end",
							contentIndex: 0,
							toolCall,
							partial: message,
						});
						stream.push({ type: "done", reason: "toolUse", message });
					} else {
						const message = assistant([], "stop");
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					}
					return stream;
				},
			});
			let component: ToolExecutionComponent | undefined;
			const eventOrder: string[] = [];
			agent.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					tui.beginTrace();
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						undefined,
						tool,
						{ requestRender: (): void => undefined } as unknown as TUI,
						root,
					);
					component.markExecutionStarted();
				}
				if (event.type === "tool_execution_update") {
					if (component === undefined) throw new Error("Missing apply_patch component");
					component.updateResult({ ...event.partialResult, isError: false }, true);
					const rendered = stripTerminalSequences(component.render(100).join("\n"));
					if (rendered.includes("○ create first.txt +1")) eventOrder.push("parsed");
					if (rendered.includes("✓ create first.txt +1")) eventOrder.push("committed");
				}
				if (event.type === "tool_execution_end") eventOrder.push("end");
			});
			await agent.prompt("apply the patch");
			expect(eventOrder.indexOf("parsed")).toBeGreaterThanOrEqual(0);
			expect(eventOrder.indexOf("committed")).toBeGreaterThanOrEqual(0);
			expect(eventOrder.indexOf("end")).toBeGreaterThan(eventOrder.indexOf("committed"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
