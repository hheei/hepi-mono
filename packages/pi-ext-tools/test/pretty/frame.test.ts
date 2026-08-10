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
					renderResult: (_result, _options, receivedTheme): Text =>
						new Text(receivedTheme.bg("toolSuccessBg", "result body"), 0, 0),
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

	test("collapses prior traces until tools are globally expanded", (): void => {
		const trace = new ToolTraceController();
		const framed = withToolFrame(tool(), trace);
		trace.startTrace();
		trace.begin("call-1");
		trace.complete("call-1");
		trace.startTrace();
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
		const collapsedLines = collapsed?.render(80) ?? [];
		expect(collapsedLines[1]).toBe("");
		expect(collapsedLines[2]?.trim()).toBe("<dim>0ms</dim>");
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

	test("keeps typed warning status and footer when Pi marks a partial result as error", (): void => {
		const trace = new ToolTraceController();
		const framed = withToolFrame(tool(), trace, () => "actual partial metrics");
		trace.startTrace();
		trace.begin("call-1");
		trace.complete("call-1", true);
		trace.startTrace();
		const result = framed.renderResult?.(
			{ content: [{ type: "text", text: "result body" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			{
				...(context(false, true) as object),
				args: { path: "src/a.ts" },
				toolCallId: "call-1",
				executionStarted: false,
				expanded: false,
				invalidate: (): void => undefined,
			} as never,
		);
		const lines = result?.render(80) ?? [];
		expect(lines[0]).toContain("<warning>!</warning>");
		expect(lines[2]?.trim()).toBe("<dim>actual partial metrics</dim>");
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
