import { describe, expect, test } from "bun:test";
import type {
	AgentToolResult,
	ExtensionContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createToolTui,
	DEFAULT_MAX_BODY_LINES,
	getToolTui,
	registerToolTuiTrace,
} from "../src/tool-tui.js";

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
		toolCallId: "call-1",
		executionStarted: true,
		expanded: false,
		invalidate: (): void => undefined,
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

function renderResult(
	framed: ToolDefinition<typeof Params>,
	result: AgentToolResult<unknown>,
	lastComponent?: ReturnType<NonNullable<ToolDefinition<typeof Params>["renderResult"]>>,
): string[] {
	const renderContext = {
		...(context(false) as object),
		...(lastComponent === undefined ? {} : { lastComponent }),
	} as never;
	return (
		framed
			.renderResult?.(result, { expanded: false, isPartial: false }, theme, renderContext)
			.render(80)
			.map((line) => line.trimEnd()) ?? []
	);
}

describe("ToolTui", () => {
	test("shares one host controller and trace subscription across consumers", (): void => {
		const agentStarts: Array<(event: unknown, context: ExtensionContext) => void> = [];
		const pi = {
			on(event: string, handler: (event: unknown, context: ExtensionContext) => void): void {
				if (event === "agent_start") agentStarts.push(handler);
			},
		} as never;
		expect(getToolTui(pi)).toBe(getToolTui(pi));
		registerToolTuiTrace(pi);
		registerToolTuiTrace(pi);
		expect(agentStarts).toHaveLength(1);
	});
	test("collapses persisted tool rows after reload before the next agent start", async (): Promise<void> => {
		const agentStarts: Array<(event: unknown, context: ExtensionContext) => void> = [];
		const sessionStarts: Array<(event: { reason: string }, context: ExtensionContext) => void> = [];
		const events = { emit: (): void => undefined, on: (): void => undefined };
		const on = (
			event: string,
			handler: (event: unknown, context: ExtensionContext) => void,
		): void => {
			if (event === "agent_start") agentStarts.push(handler);
			if (event === "session_start")
				sessionStarts.push(
					handler as (event: { reason: string }, context: ExtensionContext) => void,
				);
		};
		const firstPi = { events, on } as never;
		const firstTui = getToolTui(firstPi);
		registerToolTuiTrace(firstPi);
		const agentStart = agentStarts[0];
		if (agentStart === undefined) throw new Error("Missing ToolTui trace handler");
		agentStart({}, {} as ExtensionContext);
		const firstFrame = firstTui.frame(tool(), { footer: () => "metrics" });
		const completed = await firstFrame.execute(
			"persisted-call",
			{ path: "src/a.ts" },
			undefined,
			undefined,
			{ cwd: process.cwd() } as ExtensionContext,
		);

		const reloadedPi = { events, on } as never;
		const reloadedTui = getToolTui(reloadedPi);
		registerToolTuiTrace(reloadedPi);
		expect(reloadedTui).toBe(firstTui);
		const reload = sessionStarts.at(-1);
		if (reload === undefined) throw new Error("Missing ToolTui reload handler");
		reload({ reason: "reload" }, {} as ExtensionContext);
		const reloadedFrame = reloadedTui.frame(tool(), { footer: () => "metrics" });
		const historical = reloadedFrame
			.renderResult?.(completed, { expanded: false, isPartial: false }, theme, {
				...(context(false) as object),
				executionStarted: false,
				toolCallId: "persisted-call",
			} as never)
			.render(80)
			.map((line) => line.trimEnd());
		expect(historical).toEqual(["<dim>metrics</dim>"]);
	});

	test("owns unboxed headers, body rails, and footer", (): void => {
		const tui = createToolTui();
		const framed = tui.frame(tool(), { footer: () => "1 line · 2ms" });
		expect(framed.renderShell).toBe("self");
		const call = framed.renderCall?.({ path: "src/a.ts" }, theme, context(true));
		const callLines = call?.render(200).map((line) => line.trimEnd()) ?? [];
		expect(callLines[0]).toContain(
			"<warning>◐</warning> <toolTitle><b>read</b></toolTitle> src/a.ts",
		);
		expect(callLines[1]).toBe(`<success>${"─".repeat(200)}</success>`);
		expect(callLines[2]).toBe("call body");
		expect(callLines[3]).toBe(`<success>${"─".repeat(200)}</success>`);
		expect(
			renderResult(framed, {
				content: [{ type: "text", text: "result body" }],
				details: undefined,
			}),
		).toEqual([
			`<success>${"─".repeat(80)}</success>`,
			"result body",
			`<success>${"─".repeat(80)}</success>`,
			"<dim>1 line · 2ms</dim>",
		]);
	});

	test("keeps model-time call preview expanded before execution starts", (): void => {
		const framed = createToolTui().frame(tool());
		const call = framed.renderCall?.({ path: "src/a.ts" }, theme, {
			...(context(true) as object),
			executionStarted: false,
		} as never);
		const lines = call?.render(200).map((line) => line.trimEnd()) ?? [];
		expect(lines[0]).toContain("<warning>◐</warning> <toolTitle><b>read</b></toolTitle> src/a.ts");
		expect(lines).toContain("call body");
	});

	test("wraps current headers and truncates only collapsed headers", (): void => {
		const tui = createToolTui();
		const framed = tui.frame(tool());
		tui.beginTrace();
		const current = framed
			.renderCall?.({ path: "a/very/long/current-trace/path.ts" }, theme, context(true))
			.render(12)
			.join("");
		expect(current).toContain("a/very/long/current-trace/path.ts");
		expect(current).not.toContain("…");

		tui.beginTrace();
		const historical = framed
			.renderCall?.({ path: "a/very/long/current-trace/path.ts" }, theme, {
				...(context(false) as object),
				executionStarted: false,
			} as never)
			.render(12)
			.join("");
		expect(historical).toContain("…");
	});

	test("derives all four body layouts from rendered lines and typed footer", (): void => {
		const tui = createToolTui();
		const body = (text: string, footer?: string): string[] => {
			const framed = tui.frame(
				{
					...tool(),
					renderResult: () => (text === "<empty>" ? new Container() : new Text(text, 0, 0)),
				},
				footer === undefined ? {} : { footer: () => footer },
			);
			return renderResult(framed, { content: [], details: undefined });
		};
		expect(body("body", "footer")).toEqual([
			`<success>${"─".repeat(80)}</success>`,
			"body",
			`<success>${"─".repeat(80)}</success>`,
			"<dim>footer</dim>",
		]);
		expect(body("body")).toEqual([
			`<success>${"─".repeat(80)}</success>`,
			"body",
			`<success>${"─".repeat(80)}</success>`,
		]);
		expect(body("<empty>", "footer")).toEqual(["<dim>footer</dim>"]);
		expect(body("<empty>")).toEqual([]);
	});

	test("unwraps the previous body component for renderer reuse", (): void => {
		const tui = createToolTui();
		let reused = false;
		const framed = tui.frame({
			...tool(),
			renderResult: (_result, _options, _theme, receivedContext) => {
				let text: Text;
				if (receivedContext.lastComponent instanceof Text) {
					reused = true;
					text = receivedContext.lastComponent;
				} else text = new Text("first", 0, 0);
				text.setText("updated");
				return text;
			},
		});
		const result = { content: [], details: undefined };
		const first = framed.renderResult?.(
			result,
			{ expanded: false, isPartial: true },
			theme,
			context(true),
		);
		framed.renderResult?.(result, { expanded: false, isPartial: true }, theme, {
			...(context(true) as object),
			lastComponent: first,
		} as never);
		expect(reused).toBe(true);
	});

	test("keeps partial output in the result slot and collapses completed prior traces", async (): Promise<void> => {
		const tui = createToolTui();
		const framed = tui.frame({
			...tool(),
			async execute(_id, _params, _signal, onUpdate) {
				onUpdate?.({ content: [{ type: "text", text: "streaming result" }], details: undefined });
				return { content: [{ type: "text", text: "result body" }], details: undefined };
			},
		});
		tui.beginTrace();
		let partial: AgentToolResult<unknown> | undefined;
		const completed = await framed.execute(
			"call-1",
			{ path: "src/a.ts" },
			undefined,
			(update) => {
				partial = update;
			},
			{ cwd: process.cwd() } as ExtensionContext,
		);
		const call = framed.renderCall?.({ path: "src/a.ts" }, theme, context(true));
		expect(call?.render(80).join("\n")).not.toContain("streaming result");
		if (partial === undefined) throw new Error("Expected partial result");
		expect(
			framed
				.renderResult?.(partial, { expanded: false, isPartial: true }, theme, context(true))
				.render(80)
				.join("\n"),
		).toContain("streaming result");

		tui.beginTrace();
		const historicalContext = {
			...(context(false) as object),
			executionStarted: false,
		} as never;
		const collapsedCall = framed.renderCall?.({ path: "src/a.ts" }, theme, historicalContext);
		const collapsedResult = framed.renderResult?.(
			completed,
			{ expanded: false, isPartial: false },
			theme,
			historicalContext,
		);
		expect(
			[...(collapsedCall?.render(80) ?? []), ...(collapsedResult?.render(80) ?? [])]
				.join("\n")
				.match(/<b>read<\/b>/g),
		).toHaveLength(1);
		expect(collapsedResult?.render(80).map((line) => line.trimEnd())).toEqual(["<dim>0ms</dim>"]);
	});

	test("restores warning presentation without synchronously repeating the result", async (): Promise<void> => {
		const tui = createToolTui();
		const framed = tui.frame(tool(), {
			footer: () => "partial metrics",
			warning: () => true,
		});
		let invalidations = 0;
		const restoredContext = {
			...(context(false, true) as object),
			executionStarted: false,
			invalidate: (): void => {
				invalidations += 1;
			},
		} as never;
		framed.renderCall?.({ path: "src/a.ts" }, theme, restoredContext);
		const restored = { content: [{ type: "text" as const, text: "body" }], details: undefined };
		const result = framed.renderResult?.(
			restored,
			{ expanded: false, isPartial: false },
			theme,
			restoredContext,
		);
		expect(result?.render(80).map((line) => line.trimEnd())).toEqual([
			"<dim>partial metrics</dim>",
		]);
		expect(invalidations).toBe(0);
		await Promise.resolve();
		expect(invalidations).toBe(1);
		const call = framed.renderCall?.({ path: "src/a.ts" }, theme, restoredContext);
		expect(call?.render(80).join("\n")).toContain("<warning>!</warning>");
	});

	test("uses the host text fallback when a tool has no renderer", (): void => {
		const framed = createToolTui().frame(tool(false));
		expect(
			renderResult(framed, {
				content: [{ type: "text", text: "result body" }],
				details: undefined,
			}).join("\n"),
		).toContain("<toolOutput>result body</toolOutput>");
	});

	test("caps an unexpanded body at 20 rows and lets tools override", (): void => {
		const lines = Array.from(
			{ length: DEFAULT_MAX_BODY_LINES + 10 },
			(_, index) => `line ${index + 1}`,
		);
		const tui = createToolTui();
		const defaulted = tui.frame({
			...tool(),
			renderResult: () => new Text(lines.join("\n"), 0, 0),
		});
		const overridden = tui.frame(
			{
				...tool(),
				renderResult: () => new Text(lines.join("\n"), 0, 0),
			},
			{ maxBodyLines: 8 },
		);
		const result = { content: [], details: undefined };
		const capped = renderResult(defaulted, result).filter((line) => !line.includes("─"));
		expect(capped).toHaveLength(DEFAULT_MAX_BODY_LINES);
		expect(capped[0]).toContain(`… (11 earlier lines, ctrl+o to expand)`);
		expect(capped.at(-1)).toContain(`line ${lines.length}`);
		const custom = renderResult(overridden, result).filter((line) => !line.includes("─"));
		expect(custom).toHaveLength(8);
		expect(custom[0]).toContain("… (23 earlier lines, ctrl+o to expand)");
		const expanded =
			defaulted
				.renderResult?.(result, { expanded: true, isPartial: false }, theme, context(false))
				.render(80)
				.filter((line) => !line.includes("─")) ?? [];
		expect(expanded).toHaveLength(lines.length);
	});

	test("colors body rails from success or error", (): void => {
		const tui = createToolTui();
		const ok = tui.frame({
			...tool(),
			renderResult: () => new Text("body", 0, 0),
		});
		const warned = tui.frame(
			{
				...tool(),
				renderResult: () => new Text("body", 0, 0),
			},
			{ warning: () => true },
		);
		const result = { content: [], details: undefined };
		const successRail = `<success>${"─".repeat(80)}</success>`;
		const errorRail = `<error>${"─".repeat(80)}</error>`;
		expect(renderResult(ok, result)[0]).toBe(successRail);
		expect(renderResult(warned, result)[0]).toBe(errorRail);
		const failed =
			ok
				.renderResult?.(result, { expanded: false, isPartial: false }, theme, context(false, true))
				.render(80)
				.map((line) => line.trimEnd()) ?? [];
		expect(failed[0]).toBe(errorRail);
	});
});
