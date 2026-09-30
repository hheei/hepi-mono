import type {
	AgentToolResult,
	ExtensionContext,
	ExtensionToolContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	AUTO_COLLAPSE_DELAY_MS,
	AUTO_COLLAPSE_RETRY_DELAY_MS,
	createToolTui,
	DEFAULT_MAX_BODY_LINES,
	getToolTui,
	isTuiScrolledUp,
	registerToolTuiTrace,
	type ToolTui,
} from "../src/tool-tui.js";

const Params = Type.Record(Type.String(), Type.Unknown());
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
	// A collapsed footer prints the real execution duration, so a test that asserts an exact number
	// freezes that clock instead of hoping the machine stayed idle. Restoration also covers a test
	// that failed before restoring its own timers.
	afterEach(() => {
		vi.useRealTimers();
	});
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
			{ cwd: process.cwd() } as unknown as ExtensionToolContext,
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
			"<warning>󰪠</warning> <toolTitle><b>read</b></toolTitle> src/a.ts",
		);
		expect(callLines[1]).toBe(`<muted>${"─".repeat(200)}</muted>`);
		expect(callLines[2]).toBe("call body");
		expect(callLines[3]).toBe(`<muted>${"─".repeat(200)}</muted>`);
		expect(
			renderResult(framed, {
				content: [{ type: "text", text: "result body" }],
				details: undefined,
			}),
		).toEqual([
			`<muted>${"─".repeat(80)}</muted>`,
			"result body",
			`<muted>${"─".repeat(80)}</muted>`,
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
		expect(lines[0]).toContain("<warning>󰪠</warning> <toolTitle><b>read</b></toolTitle> src/a.ts");
		expect(lines).toContain("call body");
	});

	test("paints grep and find in-path together and dims both on later traces", (): void => {
		const tui = createToolTui();
		for (const name of ["grep", "find"] as const) {
			const framed = tui.frame({ ...tool(), name, label: name });
			tui.beginTrace();
			const current =
				framed
					.renderCall?.({ pattern: "needle", path: "src" }, theme, context(true))
					.render(200)
					.join("\n") ?? "";
			expect(current).toContain("in src");
			expect(current).not.toContain("<text>in src</text>");
			expect(current).not.toContain("<dim>in src</dim>");
			tui.beginTrace();
			const historical =
				framed
					.renderCall?.({ pattern: "needle", path: "src" }, theme, {
						...(context(false) as object),
						executionStarted: false,
					} as never)
					.render(200)
					.join("\n") ?? "";
			expect(historical).toContain("<dim>in src</dim>");
			expect(historical).not.toContain("<text>in src</text>");
		}
	});

	test("prefixes remote paths with a warning-colored host", (): void => {
		const tui = createToolTui();
		const read = tui.frame(tool());
		const readHeader =
			read
				.renderCall?.(
					{ path: ".bashrc", target: "ileqm", offset: 1, limit: 20 },
					theme,
					context(true),
				)
				.render(200)
				.join("\n") ?? "";
		expect(readHeader).toContain(
			"<toolTitle><b>read</b></toolTitle> <warning>ileqm:</warning>.bashrc<warning>:1-20</warning>",
		);
		expect(readHeader).not.toContain("@ileqm");

		const local =
			read.renderCall?.({ path: "src/a.ts" }, theme, context(true)).render(200).join("\n") ?? "";
		expect(local).toContain("<toolTitle><b>read</b></toolTitle> src/a.ts");
		expect(local).not.toContain("<warning>local:");

		const grep = tui.frame({ ...tool(), name: "grep", label: "grep" });
		const grepHeader =
			grep
				.renderCall?.(
					{ pattern: "CLUSTER", path: ".bashrc", target: "ileqm" },
					theme,
					context(true),
				)
				.render(200)
				.join("\n") ?? "";
		expect(grepHeader).toContain("in <warning>ileqm:</warning>.bashrc");

		tui.beginTrace();
		tui.beginTrace();
		const historical =
			read
				.renderCall?.({ path: ".bashrc", target: "ileqm", offset: 1, limit: 20 }, theme, {
					...(context(false) as object),
					executionStarted: false,
				} as never)
				.render(200)
				.join("\n") ?? "";
		expect(historical).toContain("<dim>ileqm:.bashrc</dim><dim>:1-20</dim>");
		expect(historical).not.toContain("<warning>ileqm:</warning>");
	});

	test("stands a summary-less header on its call facts alone", (): void => {
		const tui = createToolTui();
		const framed = tui.frame(
			{ ...tool(), name: "bash", label: "bash" },
			{
				summary: () => "",
				suffix: () => "non-blocking (timeout 30s)",
			},
		);
		tui.beginTrace();
		const current =
			framed.renderCall?.({ command: "ls -la" }, theme, context(true)).render(200).join("\n") ?? "";
		// The command is the request body, so the header never repeats it.
		expect(current).toContain(
			"<toolTitle><b>bash</b></toolTitle><dim> non-blocking (timeout 30s)</dim>",
		);
		expect(current).not.toContain("ls -la");
	});

	test("paints summary-override SSH host before the summary", (): void => {
		const tui = createToolTui();
		const framed = tui.frame(
			{
				...tool(),
				name: "apply_patch",
				label: "apply_patch",
			},
			{ summary: () => "2 files", summarySeparator: "space" },
		);
		tui.beginTrace();
		const current =
			framed
				.renderCall?.({ patch: "...", target: "devbox" }, theme, context(true))
				.render(200)
				.join("\n") ?? "";
		expect(current).toContain(
			"<toolTitle><b>apply_patch</b></toolTitle> <warning>(devbox)</warning> 2 files",
		);
		tui.beginTrace();
		const historical =
			framed
				.renderCall?.({ patch: "...", target: "devbox" }, theme, {
					...(context(false) as object),
					executionStarted: false,
				} as never)
				.render(200)
				.join("\n") ?? "";
		expect(historical).toContain(
			"<toolTitle><b>apply_patch</b></toolTitle> <dim>(devbox)</dim> <dim>2 files</dim>",
		);
		expect(historical).not.toContain("<warning>(devbox)</warning>");
	});

	test("keeps an SSH host before a summary-less run of facts", (): void => {
		const tui = createToolTui();
		const framed = tui.frame(
			{
				...tool(),
				name: "bash",
				label: "bash",
			},
			{ summary: () => "", suffix: () => "(timeout 30s)" },
		);
		tui.beginTrace();
		const current =
			framed
				.renderCall?.({ command: "uname -s", target: "devbox" }, theme, context(true))
				.render(200)
				.join("\n") ?? "";
		expect(current).toContain(
			"<toolTitle><b>bash</b></toolTitle> <warning>(devbox)</warning><dim> (timeout 30s)</dim>",
		);
		tui.beginTrace();
		const historical =
			framed
				.renderCall?.({ command: "uname -s", target: "devbox" }, theme, {
					...(context(false) as object),
					executionStarted: false,
				} as never)
				.render(200)
				.join("\n") ?? "";
		expect(historical).toContain(
			"<toolTitle><b>bash</b></toolTitle> <dim>(devbox)</dim><dim> (timeout 30s)</dim>",
		);
		expect(historical).not.toContain("<warning>(devbox)</warning>");
	});

	test("dims body text on later traces to match in-path", (): void => {
		const tui = createToolTui();
		const framed = tui.frame({
			...tool(),
			name: "bash",
			label: "bash",
			renderResult: (_result, _options, receivedTheme): Text =>
				new Text(receivedTheme.fg("text", "stdout"), 0, 0),
		});
		tui.beginTrace();
		const current = renderResult(framed, { content: [], details: undefined });
		expect(current.join("\n")).toContain("stdout");
		expect(current.join("\n")).not.toContain("<text>stdout</text>");
		tui.beginTrace();
		const historical =
			framed
				.renderResult?.(
					{ content: [], details: undefined },
					{ expanded: true, isPartial: false },
					theme,
					{
						...(context(false) as object),
						executionStarted: false,
						expanded: true,
					} as never,
				)
				.render(200)
				.map((line) => line.trimEnd()) ?? [];
		expect(historical.join("\n")).toContain("<dim>stdout</dim>");
		expect(historical.join("\n")).not.toContain("<text>stdout</text>");
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

	test("truncates a header that opted out of wrapping", (): void => {
		const tui = createToolTui();
		const long = "printf one; printf two; printf three; printf four; printf five";
		const presentation = { summary: () => long, suffix: () => "(timeout 20s)" };
		const wrapping = tui.frame(tool(false), presentation);
		const truncated = tui.frame(tool(false), { ...presentation, headerLine: "truncate" });
		const wide = wrapping.renderCall?.({}, theme, context(true)).render(40) ?? [];
		const narrow = truncated.renderCall?.({}, theme, context(true)).render(40) ?? [];
		expect(wide.length).toBeGreaterThan(1);
		expect(wide.join("")).toContain("printf five");
		expect(narrow).toHaveLength(1);
		expect(narrow[0]).toContain("…");
		expect(narrow[0]).not.toContain("printf five");
		// The facts outlive the truncation of the text they follow.
		expect(narrow[0]).toContain("(timeout 20s)");
	});

	test("keeps an overlong footer inside the terminal width", (): void => {
		const plain = {
			bg: (_role: string, text: string): string => text,
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		} as Theme;
		const footer = "1,234 matches · 123 files · 4,000 lines · 1.2s";
		const framed = (presentation: { headerLine?: "truncate" }): ToolDefinition<typeof Params> =>
			tui.frame(
				{ ...tool(), renderResult: () => new Text("body", 0, 0) },
				{
					...presentation,
					footer: () => footer,
				},
			);
		const rows = (definition: ToolDefinition<typeof Params>): string[] =>
			definition
				.renderResult?.(
					{ content: [], details: undefined },
					{ expanded: false, isPartial: false },
					plain,
					context(false),
				)
				.render(40) ?? [];
		const tui = createToolTui();
		const wrapped = rows(framed({}));
		expect(wrapped.every((row) => visibleWidth(row) <= 40)).toBe(true);
		expect(wrapped.slice(3).join(" ")).toContain("1.2s");
		expect(wrapped.length).toBeGreaterThan(4);
		const truncated = rows(framed({ headerLine: "truncate" }));
		expect(truncated).toHaveLength(4);
		expect(visibleWidth(truncated[3] ?? "")).toBe(40);
		expect(truncated[3]).toContain("…");
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
			`<muted>${"─".repeat(80)}</muted>`,
			"body",
			`<muted>${"─".repeat(80)}</muted>`,
			"<dim>footer</dim>",
		]);
		expect(body("body")).toEqual([
			`<muted>${"─".repeat(80)}</muted>`,
			"body",
			`<muted>${"─".repeat(80)}</muted>`,
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
		vi.useFakeTimers({ toFake: ["performance"] });
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
			{ cwd: process.cwd() } as unknown as ExtensionToolContext,
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

	test("promotes a streamed call to the current trace when execution starts", (): void => {
		const tui = createToolTui();
		const framed = tui.frame({
			...tool(),
			name: "bash",
			label: "bash",
			renderCall: (args, receivedTheme): Text =>
				new Text(
					receivedTheme.fg("muted", String((args as { command?: string }).command ?? "")),
					0,
				),
		});
		tui.beginTrace();
		const previewContext = {
			...(context(true) as object),
			executionStarted: false,
		} as never;
		framed.renderCall?.({ command: "printf hello" }, theme, previewContext);

		const executionContext = {
			...(context(false) as object),
			executionStarted: true,
		} as never;
		const result = framed.renderResult?.(
			{ content: [{ type: "text", text: "result body" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			executionContext,
		);
		expect(result?.render(80).join("\n")).toContain("result body");

		tui.beginTrace();
		const historical = framed.renderResult?.(
			{ content: [{ type: "text", text: "result body" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			{ ...(context(false) as object), executionStarted: false } as never,
		);
		expect(historical?.render(80).join("\n")).not.toContain("result body");
	});

	test("collapses a promoted call on later traces that still report execution start", (): void => {
		const tui = createToolTui();
		const framed = tui.frame(tool());
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "result body" }],
			details: undefined,
		};
		tui.beginTrace();
		framed.renderCall?.({}, theme, {
			...(context(true) as object),
			executionStarted: false,
		} as never);
		framed.renderResult?.(result, { expanded: false, isPartial: false }, theme, context(false));

		tui.beginTrace();
		expect(
			framed
				.renderResult?.(result, { expanded: false, isPartial: false }, theme, context(false))
				.render(80)
				.join("\n"),
		).not.toContain("result body");
	});

	test("keeps a collapsed metrics footer when the tool returns a blank footer", async (): Promise<void> => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const tui = createToolTui();
		const framed = tui.frame(tool(), { footer: () => "" });
		tui.beginTrace();
		const completed = await framed.execute(
			"call-blank-footer",
			{ path: "src/a.ts" },
			undefined,
			undefined,
			{ cwd: process.cwd() } as unknown as ExtensionToolContext,
		);
		tui.beginTrace();
		const historicalContext = {
			...(context(false) as object),
			executionStarted: false,
		} as never;
		const collapsed = framed
			.renderResult?.(completed, { expanded: false, isPartial: false }, theme, historicalContext)
			.render(80)
			.map((line) => line.trimEnd());
		expect(collapsed).toEqual(["<dim>0ms</dim>"]);
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
		expect(call?.render(80).join("\n")).toContain("<warning>󰀪</warning>");
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

	test("uses muted body rails regardless of status", (): void => {
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
		const mutedRail = `<muted>${"─".repeat(80)}</muted>`;
		expect(renderResult(ok, result)[0]).toBe(mutedRail);
		expect(renderResult(warned, result)[0]).toBe(mutedRail);
		const failed =
			ok
				.renderResult?.(result, { expanded: false, isPartial: false }, theme, context(false, true))
				.render(80)
				.map((line) => line.trimEnd()) ?? [];
		expect(failed[0]).toBe(mutedRail);
	});
});

type LongToolHarness = {
	readonly framed: ToolDefinition<typeof Params>;
	readonly result: AgentToolResult<unknown>;
	readonly invalidations: { count: number };
	bodyRenders: number;
};

async function longTool(tui: ToolTui, longOutput = true): Promise<LongToolHarness> {
	const harness = {
		framed: undefined as unknown as ToolDefinition<typeof Params>,
		result: undefined as unknown as AgentToolResult<unknown>,
		invalidations: { count: 0 },
		bodyRenders: 0,
	};
	harness.framed = tui.frame(
		{
			...tool(false),
			renderResult: (): Text => {
				harness.bodyRenders += 1;
				return new Text("result body", 0, 0);
			},
		},
		longOutput ? { longOutput: true, footer: () => "metrics" } : { footer: () => "metrics" },
	);
	harness.result = await harness.framed.execute("call-1", {}, undefined, undefined, {
		cwd: process.cwd(),
	} as unknown as ExtensionToolContext);
	return harness;
}

function renderLong(harness: LongToolHarness, expanded = false): string[] {
	return (
		harness.framed
			.renderResult?.(harness.result, { expanded, isPartial: false }, theme, {
				...(context(false) as object),
				expanded,
				invalidate: () => {
					harness.invalidations.count += 1;
				},
			} as never)
			.render(80)
			.map((line) => line.trimEnd()) ?? []
	);
}

/** Renders once so the record owns the invalidate callback, then drops setup noise. */
async function settle(harness: LongToolHarness): Promise<string[]> {
	const lines = renderLong(harness);
	await vi.advanceTimersByTimeAsync(0);
	harness.invalidations.count = 0;
	return lines;
}

describe("ToolTui collapse modes", () => {
	test("recomputes frame rows only when the width changes", (): void => {
		let painted = 0;
		const counted = {
			bg: (_role: string, text: string): string => {
				painted += 1;
				return text;
			},
			fg: (_role: string, text: string): string => {
				painted += 1;
				return text;
			},
			bold: (text: string): string => text,
		} as Theme;
		const tui = createToolTui();
		const framed = tui.frame(
			{ ...tool(), renderResult: () => new Text("body", 0, 0) },
			{
				headerLine: "truncate",
				longOutput: true,
				footer: () => "1,234 matches · 123 files · 4,000 lines",
			},
		);
		const result = { content: [], details: undefined };
		const frame = framed.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			counted,
			context(false),
		);
		const first = frame?.render(40) ?? [];
		const afterFirst = painted;
		const second = frame?.render(40) ?? [];
		expect(second).toEqual(first);
		expect(painted).toBe(afterFirst);
		frame?.render(41);
		expect(painted).toBeGreaterThan(afterFirst);
	});

	test("reuses the rows of a collapsed frame while the width is unchanged", (): void => {
		const tui = createToolTui();
		const framed = tui.frame(
			{ ...tool(), renderResult: () => new Text("body", 0, 0) },
			{ footer: () => "123 matches · 12 files · 400 lines · 1.2s" },
		);
		const ctx = context(false);
		// The first render registers the call in the current trace; the next one is prior to it.
		framed.renderResult?.(
			{ content: [], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		tui.beginTrace();
		const summary = framed.renderResult?.(
			{ content: [], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			ctx,
		);
		expect(summary?.render(40)).toBe(summary?.render(40));
		const header = framed.renderCall?.({ pattern: "needle" }, theme, ctx);
		expect(header?.render(40)).toBe(header?.render(40));
	});

	test("auto collapses a long tool one delay after completion", async (): Promise<void> => {
		vi.useFakeTimers();
		try {
			const harness = await longTool(createToolTui());
			expect(await settle(harness)).toContain("result body");
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_DELAY_MS - 1);
			expect(renderLong(harness)).toContain("result body");
			await vi.advanceTimersByTimeAsync(1);
			expect(harness.invalidations.count).toBe(1);
			expect(renderLong(harness)).toEqual(["<dim>metrics</dim>"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("on collapses on the first completed frame without rendering the body", async (): Promise<void> => {
		const tui = createToolTui();
		tui.setToolCollapseMode("on");
		const harness = await longTool(tui);
		expect(renderLong(harness)).toEqual(["<dim>metrics</dim>"]);
		expect(harness.bodyRenders).toBe(0);
	});

	test("truncates a collapsed summary row instead of wrapping it", async (): Promise<void> => {
		const tui = createToolTui();
		tui.setToolCollapseMode("on");
		const framed = tui.frame(
			{ ...tool(false), renderResult: () => new Text("result body", 0, 0) },
			{
				longOutput: true,
				footer: () => "123 matches · 12 files · 400 lines · 1.2s · one more detail",
			},
		);
		const result = await framed.execute("call-1", {}, undefined, undefined, {
			cwd: process.cwd(),
		} as unknown as ExtensionToolContext);
		const rows =
			framed
				.renderResult?.(result, { expanded: false, isPartial: false }, theme, context(false))
				.render(40)
				.map((line) => line.trimEnd()) ?? [];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("<dim>…</dim>");
		expect(rows[0]).not.toContain("one more detail");
	});

	test("on suppresses streaming updates of a long tool", async (): Promise<void> => {
		const tui = createToolTui();
		tui.setToolCollapseMode("on");
		const updates: AgentToolResult<unknown>[] = [];
		const forward = (update: AgentToolResult<unknown>): void => {
			updates.push(update);
		};
		await tui
			.frame(streamingTool(), { longOutput: true })
			.execute("call-1", {}, undefined, forward, {
				cwd: process.cwd(),
			} as unknown as ExtensionToolContext);
		expect(updates).toHaveLength(0);

		await tui.frame(streamingTool(), {}).execute("call-2", {}, undefined, forward, {
			cwd: process.cwd(),
		} as unknown as ExtensionToolContext);
		expect(updates).toHaveLength(1);
	});

	test("pertrace collapses only when the next trace starts", async (): Promise<void> => {
		vi.useFakeTimers();
		try {
			const tui = createToolTui();
			tui.setToolCollapseMode("pertrace");
			const harness = await longTool(tui);
			expect(await settle(harness)).toContain("result body");
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_DELAY_MS * 2);
			expect(harness.invalidations.count).toBe(0);
			expect(renderLong(harness)).toContain("result body");
			tui.beginTrace();
			expect(renderLong(harness)).toEqual(["<dim>metrics</dim>"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("off cancels a pending timer and never collapses", async (): Promise<void> => {
		vi.useFakeTimers();
		try {
			const tui = createToolTui();
			const harness = await longTool(tui);
			expect(await settle(harness)).toContain("result body");
			tui.setToolCollapseMode("off");
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_DELAY_MS * 2);
			tui.beginTrace();
			await vi.advanceTimersByTimeAsync(0);
			harness.invalidations.count = 0;
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_DELAY_MS * 2);
			expect(harness.invalidations.count).toBe(0);
			expect(renderLong(harness)).toContain("result body");
		} finally {
			vi.useRealTimers();
		}
	});

	test("an explicit expansion outranks every automatic collapse", async (): Promise<void> => {
		const tui = createToolTui();
		tui.setToolCollapseMode("on");
		const harness = await longTool(tui);
		expect(renderLong(harness, true)).toContain("result body");
	});

	test("leaves tools without longOutput untouched in every mode", async (): Promise<void> => {
		const tui = createToolTui();
		for (const mode of ["auto", "on", "pertrace", "off"] as const) {
			tui.setToolCollapseMode(mode);
			const harness = await longTool(tui, false);
			expect(renderLong(harness)).toContain("result body");
		}
	});

	test("drops pending timers on session reset and turn boundaries", async (): Promise<void> => {
		vi.useFakeTimers();
		try {
			const tui = createToolTui();
			const reset = await longTool(tui);
			expect(await settle(reset)).toContain("result body");
			tui.resetSession();
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_DELAY_MS * 2);
			expect(reset.invalidations.count).toBe(0);

			const nextTurn = await longTool(tui);
			expect(await settle(nextTurn)).toContain("result body");
			tui.beginTrace();
			await vi.advanceTimersByTimeAsync(0);
			nextTurn.invalidations.count = 0;
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_DELAY_MS * 2);
			expect(nextTurn.invalidations.count).toBe(0);
			expect(renderLong(nextTurn)).toEqual(["<dim>metrics</dim>"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("postpones auto-collapse while user is scrolled up away from bottom", async (): Promise<void> => {
		vi.useFakeTimers();
		try {
			const tui = createToolTui();
			let scrolledUp = true;
			tui.setScrolledUpPredicate(() => scrolledUp);

			const harness = await longTool(tui);
			expect(await settle(harness)).toContain("result body");

			// 15 seconds pass: timer fires, but user is scrolled up reading
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_DELAY_MS);
			expect(harness.invalidations.count).toBe(0);
			expect(renderLong(harness)).toContain("result body");

			// Another retry delay passes, still scrolled up
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_RETRY_DELAY_MS);
			expect(harness.invalidations.count).toBe(0);
			expect(renderLong(harness)).toContain("result body");

			// User scrolls back down to the bottom
			scrolledUp = false;
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_RETRY_DELAY_MS);
			expect(harness.invalidations.count).toBe(1);
			expect(renderLong(harness)).toEqual(["<dim>metrics</dim>"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("postpones a prior-trace collapse while user is scrolled up away from bottom", async (): Promise<void> => {
		vi.useFakeTimers();
		try {
			const tui = createToolTui();
			let scrolledUp = true;
			tui.setScrolledUpPredicate(() => scrolledUp);

			const harness = await longTool(tui, false);
			expect(await settle(harness)).toContain("result body");

			// The next run collapses prior traces, but the reader is above the end.
			tui.beginTrace();
			expect(renderLong(harness)).toContain("result body");
			harness.invalidations.count = 0;

			// Still reading: the collapse stays postponed.
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_RETRY_DELAY_MS);
			expect(harness.invalidations.count).toBe(0);
			expect(renderLong(harness)).toContain("result body");

			// Once the reader returns to the end the postponed collapse happens.
			scrolledUp = false;
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_RETRY_DELAY_MS);
			expect(harness.invalidations.count).toBe(1);
			expect(renderLong(harness)).toEqual(["<dim>metrics</dim>"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("postpones the `on`-mode collapse while user is scrolled up away from bottom", async (): Promise<void> => {
		vi.useFakeTimers();
		try {
			const tui = createToolTui();
			tui.setToolCollapseMode("on");
			let scrolledUp = true;
			tui.setScrolledUpPredicate(() => scrolledUp);

			const harness = await longTool(tui);
			expect(await settle(harness)).toContain("result body");

			scrolledUp = false;
			await vi.advanceTimersByTimeAsync(AUTO_COLLAPSE_RETRY_DELAY_MS);
			expect(harness.invalidations.count).toBe(1);
			expect(renderLong(harness)).toEqual(["<dim>metrics</dim>"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("reads the fullscreen viewport and treats regular mode as unsupported", (): void => {
		expect(isTuiScrolledUp(undefined)).toBe(false);
		expect(isTuiScrolledUp(null)).toBe(false);
		expect(isTuiScrolledUp({})).toBe(false);

		// Regular mode writes the transcript into the terminal's own scrollback: nothing here
		// can report a reader, and patching or bypassing that is not an option.
		expect(isTuiScrolledUp({ mode: "regular" })).toBe(false);

		// Fullscreen owns the viewport, so its public follow flag is the one source of truth.
		expect(isTuiScrolledUp({ mode: "fullscreen", isFollowingOutput: true })).toBe(false);
		expect(isTuiScrolledUp({ mode: "fullscreen", isFollowingOutput: false })).toBe(true);

		// Reaching a private scroll view is not a supported reader signal either.
		expect(isTuiScrolledUp({ getPrimaryScrollView: () => ({ isFollowingEnd: false }) })).toBe(
			false,
		);
	});
});

function streamingTool(): ToolDefinition<typeof Params> {
	return {
		...tool(false),
		execute: async (_id, _params, _signal, onUpdate): Promise<AgentToolResult<unknown>> => {
			onUpdate?.({ content: [{ type: "text", text: "partial" }], details: undefined });
			return { content: [{ type: "text", text: "final" }], details: undefined };
		},
	};
}

function requestFramed(rows: string[]): { tui: ToolTui; framed: ToolDefinition<typeof Params> } {
	const tui = createToolTui();
	const framed = tui.frame(
		{
			name: "bash",
			label: "bash",
			description: "Run a command",
			parameters: Params,
			execute: async (): Promise<AgentToolResult<unknown>> => ({
				content: [{ type: "text", text: "done" }],
				details: undefined,
			}),
			renderCall: (): Text => new Text("call body", 0, 0),
			renderResult: (result, _options, receivedTheme): Component => {
				const first = result.content[0];
				const text = first?.type === "text" ? first.text : "";
				return text === ""
					? new Container()
					: new Text(receivedTheme.bg("toolSuccessBg", text), 0, 0);
			},
		},
		{
			summary: () => "git fetch --all; git rebase -i main",
			request: (_args, receivedTheme): Component =>
				new Text(receivedTheme.fg("text", rows.join("\n")), 0, 0),
			footer: () => "exit 0 · 1.2s",
		},
	);
	return { tui, framed };
}

function requestCallLines(
	framed: ToolDefinition<typeof Params>,
	args: Record<string, unknown> = {},
	options: { readonly isPartial?: boolean; readonly expanded?: boolean } = {},
	width = 80,
): string[] {
	return (
		framed
			.renderCall?.(args, theme, {
				...(context(options.isPartial ?? true) as object),
				...(options.expanded === true ? { expanded: true } : {}),
			} as never)
			.render(width)
			.map((line) => line.trimEnd()) ?? []
	);
}

describe("tool request section", () => {
	test("keeps a declared request body after the result arrives and skips the call preview", (): void => {
		const { framed } = requestFramed(["git fetch --all", "git rebase -i main"]);
		expect(requestCallLines(framed)).toContain("git fetch --all");
		const completed = requestCallLines(framed, {}, { isPartial: false });
		expect(completed).toContain("git fetch --all");
		expect(completed.join("\n")).not.toContain("call body");
	});

	test("shares one rail with the result body and closes its own section", (): void => {
		const { framed } = requestFramed(["git fetch --all"]);
		expect(requestCallLines(framed, {}, { isPartial: false }, 200)).toEqual([
			"<success>󰄴</success> <toolTitle><b>bash</b></toolTitle> <dim>·</dim> git fetch --all; git rebase -i main",
			`<muted>${"─".repeat(200)}</muted>`,
			"git fetch --all",
			`<muted>${"─".repeat(200)}</muted>`,
		]);
		expect(
			renderResult(framed, {
				content: [{ type: "text", text: "output" }],
				details: undefined,
			}),
		).toEqual(["output", `<muted>${"─".repeat(80)}</muted>`, "<dim>exit 0 · 1.2s</dim>"]);
	});

	test("closes the request section above an empty result body", (): void => {
		const { framed } = requestFramed(["git fetch --all"]);
		const call = requestCallLines(framed, {}, { isPartial: false }, 200);
		const result = renderResult(framed, { content: [], details: undefined });
		expect([...call, ...result]).toEqual([
			"<success>󰄴</success> <toolTitle><b>bash</b></toolTitle> <dim>·</dim> git fetch --all; git rebase -i main",
			`<muted>${"─".repeat(200)}</muted>`,
			"git fetch --all",
			`<muted>${"─".repeat(200)}</muted>`,
			"<dim>exit 0 · 1.2s</dim>",
		]);
	});

	test("keeps the head of an over-long request behind a later-lines hint", (): void => {
		const rows = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`);
		const { framed } = requestFramed(rows);
		const collapsed = requestCallLines(framed, {}, {}, 200).join("\n");
		expect(collapsed).toContain("line 9");
		expect(collapsed).not.toContain("line 10");
		expect(collapsed).toContain("… (5 later lines, ctrl+o to expand)");
		expect(requestCallLines(framed, {}, { expanded: true }, 200).join("\n")).toContain("line 14");
	});

	test("prints declared call facts inline and keeps that shape stable", (): void => {
		const framed = createToolTui().frame(
			{ ...tool(false), name: "eval", label: "eval" },
			{
				summary: () => "print(1)",
				suffix: (args) => {
					const values = args as { readonly reset?: boolean; readonly timeout?: number };
					return [
						...(values.reset === true ? ["(reset)"] : []),
						...(typeof values.timeout === "number" ? [`(timeout ${values.timeout}s)`] : []),
					].join(" ");
				},
				request: (_args, receivedTheme): Component =>
					new Text(receivedTheme.fg("text", "print(1)"), 0, 0),
			},
		);
		expect(requestCallLines(framed, { reset: true, timeout: 30 }, {}, 200)[0]).toBe(
			"<warning>󰪠</warning> <toolTitle><b>eval</b></toolTitle> print(1)<dim> (reset) (timeout 30s)</dim>",
		);
		expect(requestCallLines(framed, {}, {}, 200)[0]).toBe(
			"<warning>󰪠</warning> <toolTitle><b>eval</b></toolTitle> print(1)",
		);
	});

	test("cuts a request row that a tool paints wider than the terminal", (): void => {
		const framed = createToolTui().frame(
			{ ...tool(), name: "bash", label: "bash" },
			{
				headerLine: "truncate",
				request: (): Component => ({
					render: (): string[] => ["z".repeat(60)],
					invalidate: (): void => undefined,
				}),
			},
		);
		const lines = requestCallLines(framed, {}, {}, 20);
		expect(visibleWidth(lines[2] ?? "")).toBeLessThanOrEqual(20);
		expect(lines[2]).toContain("…");
	});

	test("keeps the request body on a later trace", (): void => {
		const { tui, framed } = requestFramed(["git fetch --all"]);
		const current = requestCallLines(framed, {}, { isPartial: false }, 200);
		expect(current).toContain("git fetch --all");
		expect(current.join("\n")).not.toContain("<dim>git fetch --all</dim>");
		tui.beginTrace();
		expect(
			requestCallLines(framed, {}, { isPartial: false, expanded: true }, 200).join("\n"),
		).toContain("<dim>git fetch --all</dim>");
	});
});

test("the result opens its own rail when the request rendered nothing", (): void => {
	const tui = createToolTui();
	// A declared request owns the call phase, but an empty command or code sample renders no body,
	// so there is no section above the result for it to continue.
	const framed = tui.frame(tool(), { request: () => undefined, footer: () => "1 line" });
	const call = framed.renderCall?.({ path: "src/a.ts" }, theme, context(false));
	expect(call?.render(200).map((line) => line.trimEnd()) ?? []).toEqual([
		"<success>󰄴</success> <toolTitle><b>read</b></toolTitle> src/a.ts<warning></warning>",
	]);

	expect(
		renderResult(framed, {
			content: [{ type: "text", text: "result body" }],
			details: undefined,
		}),
	).toEqual([
		`<muted>${"─".repeat(80)}</muted>`,
		"result body",
		`<muted>${"─".repeat(80)}</muted>`,
		"<dim>1 line</dim>",
	]);
});

test("the result continues the rail its request already drew", (): void => {
	const tui = createToolTui();
	const framed = tui.frame(tool(), {
		request: (_args, receivedTheme) =>
			new Text(receivedTheme.bg("toolSuccessBg", "call body"), 0, 0),
		footer: () => "1 line",
	});
	framed.renderCall?.({ path: "src/a.ts" }, theme, context(false));
	expect(
		renderResult(framed, {
			content: [{ type: "text", text: "result body" }],
			details: undefined,
		}),
	).toEqual(["result body", `<muted>${"─".repeat(80)}</muted>`, "<dim>1 line</dim>"]);
});
