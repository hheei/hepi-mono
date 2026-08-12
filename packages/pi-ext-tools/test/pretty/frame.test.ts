import { describe, expect, test } from "bun:test";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { withToolFrame } from "../../src/pretty/frame.js";
import { ToolTraceController } from "../../src/pretty/trace.js";

const Params = Type.Object({ path: Type.String() });
const theme = {
	bg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
	fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
	bold: (text: string): string => `<b>${text}</b>`,
} as Theme;

function context(isPartial: boolean, isError = false): never {
	return {
		isPartial,
		isError,
		lastComponent: undefined,
		state: {},
	} as never;
}

function tool(renderers = true): ToolDefinition<typeof Params> {
	return {
		name: "read",
		label: "read",
		description: "Read a file",
		parameters: Params,
		execute: async (): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: "result body" }],
			details: undefined,
		}),
		...(renderers
			? {
					renderCall: (_args, receivedTheme): Text =>
						new Text(receivedTheme.bg("toolSuccessBg", "call body"), 0, 0),
					renderResult: (result, _options, receivedTheme): Text => {
						const first = result.content[0];
						const text = first?.type === "text" ? first.text : "";
						return new Text(receivedTheme.bg("toolSuccessBg", text), 0, 0);
					},
				}
			: {}),
	};
}

describe("withToolFrame", () => {
	test("renders pending and completed sections without a host tool background", (): void => {
		const framed = withToolFrame(tool());
		expect(framed.renderShell).toBe("self");
		const call = framed.renderCall?.({ path: "src/a.ts" }, theme, context(true));
		const result = framed.renderResult?.(
			{ content: [{ type: "text", text: "result body" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			context(false),
		);
		const callLines = call?.render(80) ?? [];
		expect(callLines[0]).toContain("<warning>◐</warning> <toolTitle><b>read</b></toolTitle>");
		expect(callLines[1]).toBe(
			"<borderMuted>────────────────────────────────────────────────────────────────────────────────</borderMuted>",
		);
		expect(callLines[2]?.trim()).toBe("call body");
		const resultLines = result?.render(20) ?? [];
		expect(resultLines[0]).toBe("<borderMuted>────────────────────</borderMuted>");
		expect(resultLines[1]?.trim()).toBe("result body");
	});

	test("renders the latest partial result only in the result slot", (): void => {
		const trace = new ToolTraceController();
		const framed = withToolFrame(tool(), trace);
		trace.startTrace();
		trace.begin("call-1");
		trace.update("call-1", {
			content: [{ type: "text", text: "streaming result" }],
			details: undefined,
		});
		const call = framed.renderCall?.({ path: "src/a.ts" }, theme, {
			...(context(true) as object),
			toolCallId: "call-1",
			executionStarted: true,
			expanded: false,
			invalidate: (): void => undefined,
		} as never);
		const result = framed.renderResult?.(
			{ content: [{ type: "text", text: "streaming result" }], details: undefined },
			{ expanded: false, isPartial: true },
			theme,
			{
				...(context(true) as object),
				toolCallId: "call-1",
				executionStarted: true,
				expanded: false,
				invalidate: (): void => undefined,
			} as never,
		);
		const text = call?.render(80).join("\n");
		expect(text).not.toContain("streaming result");
		expect(text).not.toContain("call body");
		expect(result?.render(80).join("\n")).toContain("streaming result");
		const completedCall = framed.renderCall?.({ path: "src/a.ts" }, theme, {
			...(context(false) as object),
			toolCallId: "call-1",
			executionStarted: true,
			expanded: false,
			invalidate: (): void => undefined,
		} as never);
		const completedText = completedCall?.render(80).join("\n");
		expect(completedText).not.toContain("streaming result");
		expect(completedText).not.toContain("call body");
	});

	test("collapses prior traces until tools are globally expanded", (): void => {
		const trace = new ToolTraceController();
		const framed = withToolFrame(tool(), trace);
		trace.startTrace();
		trace.begin("call-1");
		trace.complete("call-1");
		trace.startTrace();
		const call = framed.renderCall?.({ path: "src/a.ts" }, theme, {
			...(context(false) as object),
			toolCallId: "call-1",
			executionStarted: false,
			expanded: false,
			invalidate: (): void => undefined,
		} as never);
		const collapsed = framed.renderResult?.(
			{ content: [{ type: "text", text: "result body" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			{
				...(context(false) as object),
				args: { path: "src/a.ts" },
				toolCallId: "call-1",
				executionStarted: false,
				expanded: false,
				invalidate: (): void => undefined,
			} as never,
		);
		const combined = [...(call?.render(80) ?? []), ...(collapsed?.render(80) ?? [])].join("\n");
		expect(combined.match(/<b>read<\/b>/g)).toHaveLength(1);
		const collapsedLines = collapsed?.render(80) ?? [];
		expect(collapsedLines.map((line) => line.trimEnd())).toEqual(["<dim>0ms</dim>"]);
		expect(collapsedLines.join("\n")).not.toContain("result body");

		const expanded = framed.renderResult?.(
			{ content: [{ type: "text", text: "result body" }], details: undefined },
			{ expanded: true, isPartial: false },
			theme,
			{
				...(context(false) as object),
				args: { path: "src/a.ts" },
				toolCallId: "call-1",
				executionStarted: false,
				expanded: true,
				invalidate: (): void => undefined,
			} as never,
		);
		expect(expanded?.render(80).join("\n")).toContain("result body");
	});

	test("dims historical read and grep parameters", (): void => {
		const trace = new ToolTraceController();
		const framed = withToolFrame(tool(), trace);
		trace.startTrace();
		trace.begin("call-1");
		trace.complete("call-1");
		trace.begin("grep-1");
		trace.complete("grep-1");
		trace.startTrace();
		const collapsedTheme = {
			bg: (_role: string, text: string): string => text,
			fg: (role: string, text: string): string =>
				role === "dim" ? `\u001B[2m${text}\u001B[22m` : text,
			bold: (text: string): string => text,
		} as Theme;
		const call = framed.renderCall?.({ path: `src/${"a".repeat(80)}.ts` }, collapsedTheme, {
			...(context(false) as object),
			toolCallId: "call-1",
			executionStarted: false,
			expanded: false,
			invalidate: (): void => undefined,
		} as never);
		const line = call?.render(30)[0];
		expect(line).toContain("\u001B[2msrc/");
		expect(line).toContain("\u001B[2m>\u001B[22m");
		const readRange = framed.renderCall?.(
			{ path: "src/outcome.ts", offset: 58, limit: 70 },
			collapsedTheme,
			{
				...(context(false) as object),
				toolCallId: "call-1",
				executionStarted: false,
				expanded: false,
				invalidate: (): void => undefined,
			} as never,
		);
		expect(readRange?.render(100)[0]).toContain("\u001B[2m:58-127\u001B[22m");

		const grepFramed = withToolFrame({ ...tool(), name: "grep", label: "grep" }, trace);
		const grep = grepFramed.renderCall?.({ pattern: "needle", path: "src" }, collapsedTheme, {
			...(context(false) as object),
			toolCallId: "grep-1",
			executionStarted: false,
			expanded: false,
			invalidate: (): void => undefined,
		} as never);
		const grepLine = grep?.render(100)[0];
		expect(grepLine).toContain("grep");
		expect(grepLine).toContain("\u001B[2m/needle/ in src\u001B[22m");
	});

	test("restores a warning header without synchronously repeating the result", async (): Promise<void> => {
		const trace = new ToolTraceController();
		const framed = withToolFrame(
			tool(),
			trace,
			() => "actual partial metrics",
			() => true,
		);
		trace.startTrace();
		let invalidations = 0;
		const renderContext = {
			...(context(false, true) as object),
			args: { path: "src/a.ts" },
			toolCallId: "call-1",
			executionStarted: false,
			expanded: false,
			invalidate: (): void => {
				invalidations += 1;
			},
		} as never;
		framed.renderCall?.({ path: "src/a.ts" }, theme, renderContext);
		const restoredResult = {
			content: [{ type: "text" as const, text: "result body" }],
			details: undefined,
		};
		const result = framed.renderResult?.(
			restoredResult,
			{ expanded: false, isPartial: false },
			theme,
			renderContext,
		);
		expect(result?.render(80).map((line) => line.trimEnd())).toEqual([
			"<dim>actual partial metrics</dim>",
		]);
		expect(invalidations).toBe(0);
		await Promise.resolve();
		expect(invalidations).toBe(1);
		framed.renderResult?.(
			restoredResult,
			{ expanded: false, isPartial: false },
			theme,
			renderContext,
		);
		await Promise.resolve();
		expect(invalidations).toBe(1);
		const restoredCall = framed.renderCall?.({ path: "src/a.ts" }, theme, renderContext);
		const restoredText = restoredCall?.render(80).join("\n");
		expect(restoredText).toContain("<warning>!</warning>");
		expect(restoredText).not.toContain("<error>✗</error>");
	});

	test("uses the host text fallback when a tool has no renderer", (): void => {
		const framed = withToolFrame(tool(false));
		const result = framed.renderResult?.(
			{ content: [{ type: "text", text: "result body" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			context(false),
		);
		expect(result?.render(80).join("\n")).toContain("<toolOutput>result body</toolOutput>");
	});
});
