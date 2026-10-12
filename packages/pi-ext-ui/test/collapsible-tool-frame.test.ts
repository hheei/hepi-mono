import type {
	ExtensionAPI,
	Theme,
	ToolRendererResolver,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import extension from "../src/extension.js";
import {
	type Collapsible,
	clearCapturedNestedCalls,
	formatTurnFlow,
	isCollapsible,
	recordToolExecutionEnd,
	recordToolExecutionStart,
	registerCollapsibleToolRenderer,
	SPECIALIZED_TOOL_RENDERERS,
	type ToolRenderContext,
	ToolView,
	transitionFoldLevel,
	WEB_ACCESS_TOOLS,
} from "../src/index.js";
import { NESTED_CALLS_EXPANDED_KEY, NestedCallsView } from "../src/nested-calls-view.js";

const taggedTheme = {
	fg: (color: string, text: string) => `[${color}:${text}]`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

function createMockContext(overrides?: Partial<ToolRenderContext>): ToolRenderContext {
	return {
		args: { query: "pi tui collapsible" },
		toolCallId: "call-1",
		invalidate: vi.fn(),
		lastComponent: undefined,
		state: {},
		cwd: "/work",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 0,
		...overrides,
	};
}

function createMouseClick(
	x: number,
	y: number,
	options?: { width?: number; height?: number; ctrl?: boolean; shift?: boolean },
): TuiMouseEvent {
	const width = options?.width ?? 80;
	const height = options?.height ?? 5;
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: options?.shift ?? false,
		alt: false,
		ctrl: options?.ctrl ?? false,
	};
}

describe("ToolView Deep Module Interface", () => {
	test("transitionFoldLevel satisfies the 6-path Click & Ctrl+Click matrix", () => {
		expect(transitionFoldLevel(0, false)).toBe(1);
		expect(transitionFoldLevel(0, true)).toBe(2);
		expect(transitionFoldLevel(1, false)).toBe(0);
		expect(transitionFoldLevel(1, true)).toBe(2);
		expect(transitionFoldLevel(2, false)).toBe(0);
		expect(transitionFoldLevel(2, true)).toBe(0);
	});

	test("Level 1 defaults to a 9-line section cap", () => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", status: "none", summary: "1 call" },
			sections: [
				{ railToken: "dim", content: Array.from({ length: 40 }, (_, i) => `out ${String(i)}`) },
			],
			stateHolder: {},
		});
		view.setFoldLevel(1);

		const level1 = view.render(80);
		expect(level1).toHaveLength(11);
		expect(level1[9]).toContain("out 8");
		expect(level1[10]).toContain("… (31 more lines)");
	});

	test("Level 0 renders all collapsed board rows without artificial truncation cap", () => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", status: "none", summary: "30 calls" },
			collapsedRows: Array.from({ length: 30 }, (_, i) => `✓ read a${String(i)}.ts`),
			stateHolder: {},
		});

		const level0 = view.render(80);
		expect(level0).toHaveLength(31);
		expect(level0[1]).toContain("✓ read a0.ts");
		expect(level0[30]).toContain("✓ read a29.ts");
	});

	test("Level 0 / Level 1 / Level 2 state machine via mouse clicks and section capping", () => {
		const state = {};
		const invalidate = vi.fn();
		const twentyLines = Array.from({ length: 20 }, (_, i) => `line-${String(i + 1)}`);

		const view = new ToolView({
			theme: plainTheme,
			header: { title: "web_search", status: "ok", summary: "query" },
			sections: [{ railToken: "dim", content: twentyLines, maxLines: 3 }],
			stateHolder: state,
			invalidate,
		});

		expect(view.foldLevel).toBe(0);
		const level0Lines = view.render(80);
		expect(level0Lines).toEqual(["▸ ✓ web_search query"]);

		view.handleMouse(createMouseClick(2, 0));
		expect(view.foldLevel).toBe(1);
		expect(invalidate).toHaveBeenCalledTimes(1);
		const level1Lines = view.render(80);
		expect(level1Lines).toEqual([
			"▾ ✓ web_search query",
			"▎ line-1",
			"▎ line-2",
			"▎ line-3",
			"▎ … (17 more lines)",
		]);

		view.handleMouse(createMouseClick(2, 0, { ctrl: true }));
		expect(view.foldLevel).toBe(2);
		const level2Lines = view.render(80);
		expect(level2Lines.length).toBe(21);
		expect(level2Lines[0]).toBe("▾ ✓ web_search query");
		expect(level2Lines[20]).toBe("▎ line-20");

		view.handleMouse(createMouseClick(2, 0));
		expect(view.foldLevel).toBe(0);

		view.handleMouse(createMouseClick(2, 0, { ctrl: true }));
		expect(view.foldLevel).toBe(2);

		view.handleMouse(createMouseClick(2, 0, { ctrl: true }));
		expect(view.foldLevel).toBe(0);
	});

	test("Seamless two-compartment heavy-input layout: no dashed line, no padding, segmented rail colors", () => {
		const view = new ToolView({
			theme: taggedTheme,
			defaultLevel: 1,
			header: { title: "bash", status: "ok", summary: "exit 0 · 1.2s" },
			sections: [
				{ railToken: "muted", content: ["$ pnpm build && pnpm test"] },
				{ railToken: "dim", content: ["> building...", "✓ Built in 820ms"] },
			],
		});

		const rendered = view.render(80);
		expect(rendered.length).toBe(4);
		expect(rendered[1]).toContain("[muted:▎] $ pnpm build && pnpm test");
		expect(rendered[2]).toContain("[dim:▎] > building...");
		expect(rendered[3]).toContain("[dim:▎] ✓ Built in 820ms");
	});

	test("Meta-tool layout: Level 0 shows collapsedRows without top ✓, Level 1 shows input & output sections", () => {
		const state = {};
		const view = new ToolView({
			theme: plainTheme,
			stateHolder: state,
			header: { title: "codemode", status: "none", summary: "4 calls · 2.1s" },
			collapsedRows: ["✓ grep · 14 matches (80ms)", "✗ write · Permission denied (15ms)"],
			sections: [
				{ railToken: "muted", content: ["$ await Promise.all([...])"] },
				{ railToken: "dim", content: ["Summary: 1 passed, 1 failed"] },
			],
		});

		const collapsedRender = view.render(80);
		expect(collapsedRender).toEqual([
			"▸ codemode 4 calls · 2.1s",
			"▎ ✓ grep · 14 matches (80ms)",
			"▎ ✗ write · Permission denied (15ms)",
		]);

		view.toggle(false);
		const expandedRender = view.render(80);
		expect(expandedRender).toEqual([
			"▾ codemode 4 calls · 2.1s",
			"▎ $ await Promise.all([...])",
			"▎ Summary: 1 passed, 1 failed",
		]);
	});

	test("Right-edge copy icon: Click copies primary, Shift+Click copies full, feedback expires via the timer", () => {
		vi.useFakeTimers();
		try {
			const copiedTexts: string[] = [];
			const invalidate = vi.fn();

			const view = new ToolView({
				theme: plainTheme,
				stateHolder: {},
				invalidate,
				copyToClipboard: async (text: string) => {
					copiedTexts.push(text);
				},
				copyFeedbackDurationMs: 5000,
				header: { title: "bash", status: "ok", summary: "exit 0" },
				copy: {
					primary: "pnpm test",
					full: "pnpm test\n---\nPASS",
				},
			});

			expect(view.render(40)[0]!.endsWith("󰆏 ")).toBe(true);

			const wheelResult = view.handleMouse({
				type: "wheel",
				button: "none",
				x: 10,
				y: 0,
				screenX: 10,
				screenY: 0,
				width: 40,
				height: 1,
				shift: false,
				alt: false,
				ctrl: false,
				wheelDelta: 3,
			});
			expect(wheelResult).toBeUndefined();

			const copyClick = view.handleMouse(createMouseClick(38, 0, { width: 40, height: 1 }));
			expect(copyClick).toMatchObject({ handled: true, render: true });
			expect(view.foldLevel).toBe(0);
			expect(copiedTexts).toEqual(["pnpm test"]);
			expect(view.render(40)[0]!.endsWith("✓ ")).toBe(true);

			vi.advanceTimersByTime(5000);
			expect(view.render(40)[0]!.endsWith("󰆏 ")).toBe(true);
			expect(invalidate).toHaveBeenCalled();

			view.handleMouse(createMouseClick(38, 0, { width: 40, height: 1, shift: true }));
			expect(copiedTexts).toEqual(["pnpm test", "pnpm test\n---\nPASS"]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("registerCollapsibleToolRenderer & formatTurnFlow", () => {
	function setupResolver(
		options?: Parameters<typeof registerCollapsibleToolRenderer>[1],
	): ToolRendererResolver {
		let captured: ToolRendererResolver | undefined;
		const pi = {
			registerToolRenderer(resolver: ToolRendererResolver) {
				captured = resolver;
			},
		} as unknown as ExtensionAPI;

		if (options === undefined) {
			extension(pi);
		} else {
			registerCollapsibleToolRenderer(pi, options);
		}
		if (captured === undefined) {
			throw new Error("Expected registerToolRenderer to be called");
		}
		return captured;
	}

	test("Streaming planning phase shows ▸ ⋯ tool_name · XX tokens and constant 1-line height", () => {
		const resolve = setupResolver();
		const renderers = resolve("web_search", () => undefined)!;
		const ctx = createMockContext({
			args: { query: "1234567890123456" },
			isPartial: true,
			argsComplete: false,
			executionStarted: false,
		});

		const callView = renderers.renderCall!(ctx.args, plainTheme, ctx);
		const lines = callView.render(80);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("▸ ⋯ web_search · ");
		expect(lines[0]).toContain("tokens");
	});

	test("codemode renderCall shows raw input code", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const ctx = createMockContext({
			args: { code: "const a = 1;\nconst b = 2;" },
			executionStarted: false,
			isPartial: false,
			argsComplete: true,
		});
		const callView = renderers.renderCall!(ctx.args, plainTheme, ctx) as ToolView;
		callView.handleMouse(createMouseClick(2, 0, { width: 80 }));
		const rendered = callView.render(80);
		expect(rendered.join("\n")).toContain("const a = 1;");
	});

	test("leaves ordinary tools to Pi unless explicitly opted in", () => {
		const resolve = setupResolver();
		const upstream: ToolRenderers = { renderCall: () => new Text("native", 0, 0) };
		expect(resolve("grep", () => upstream)).toBe(upstream);
		const optedIn = setupResolver({ tools: ["grep"] })("grep", () => undefined);
		expect(optedIn?.renderShell).toBe("self");
	});

	test("Keeps ordinary tools native and intercepts specialized tools", () => {
		const resolve = setupResolver();
		const otherUpstream: ToolRenderers = {
			renderCall: () => new Text("other call", 0, 0),
		};
		expect(resolve("bash", () => otherUpstream)).toBe(otherUpstream);

		for (const toolName of [...SPECIALIZED_TOOL_RENDERERS, ...WEB_ACCESS_TOOLS]) {
			const renderers = resolve(toolName, () => undefined);
			expect(renderers?.renderShell).toBe("self");
		}
		expect(resolve("read", () => undefined)).toBeUndefined();
	});

	test("codemode adapter: Level 0 shows nested calls without top ✓, Level 1 shows script & cleaned output", () => {
		const copied: string[] = [];
		const resolve = setupResolver({
			copyToClipboard: async (t) => {
				copied.push(t);
			},
		});
		const renderers = resolve("codemode", () => undefined)!;
		const state = {};
		const ctx = createMockContext({
			state,
			args: {
				code: '// @options: {"timeout_ms": 30000}\nconst res = await tools.read({ path: "a.ts" });\ntext(res);',
			},
		});

		const resultView = renderers.renderResult!(
			{
				content: [
					{
						type: "text",
						text: "Script completed\nWall time 0.2 seconds\nOutput:\nfile content line 1\nfile content line 2",
					},
				],
				details: {
					calls: [{ id: "1", name: "read", args: 'path: "a.ts"', status: "ok", durationMs: 18 }],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		const level0 = resultView.render(80);
		expect(level0[0]).toContain("▸ codemode (timeout 30s) · 1 call · 200ms");
		expect(level0[0]).not.toContain("✓");
		expect(level0[1]).toContain('▎ ✓ read path: "a.ts" · 18ms');
		expect(level0[1]).toContain("󰆏");

		// Clicking row 1 copy button copies the child tool's output
		resultView.handleMouse(createMouseClick(78, 1, { width: 80 }));
		expect(copied.length).toBe(1);
		expect(copied[0]).toBe('path: "a.ts"');

		// Checkmark icon displays after copy in child row
		const copiedRender = resultView.render(80);
		expect(copiedRender[1]).toContain("✓");

		// Clicking row 1 body toggles child tool expansion (select mechanism)
		resultView.handleMouse(createMouseClick(10, 1, { width: 80 }));
		const childExpanded = resultView.render(80);
		expect(childExpanded[1]).toContain('▎ ✓ read path: "a.ts" · 18ms');

		// Expanding codemode view itself
		resultView.handleMouse(createMouseClick(2, 0, { width: 80 }));
		const level1 = resultView.render(80);
		expect(level1[0]).toContain("▾ codemode (timeout 30s) · 1 call · 200ms");
		expect(level1.join("\n")).toContain("// @options:");
		expect(level1.join("\n")).toContain("file content line 1");
		expect(level1.join("\n")).not.toContain("Script completed");
	});

	test("a container tool keeps its call row visible until a result exists", () => {
		const resolve = setupResolver();
		for (const [toolName, expected] of [
			["python_eval", "◐ python_eval"],
			["codemode", "codemode"],
		] as const) {
			const renderers = resolve(toolName, () => undefined)!;
			const running = createMockContext({
				state: {},
				args: toolName === "codemode" ? { code: "const a = 1;" } : { code: "print(1)" },
				isPartial: true,
				argsComplete: true,
				executionStarted: true,
			});
			// Execution started and no result yet: the call row is the only thing on screen, so
			// hiding it here would leave the whole tool block blank.
			const lines = renderers.renderCall!(running.args, plainTheme, running).render(80);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(expected);
		}
	});

	test("codemode keeps one header: no spinner while running, and the call row leaves once a result exists", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const state = {};
		const running = createMockContext({
			state,
			args: { code: "await tools.agent_get({ id: 'agent-1' });" },
			isPartial: true,
			argsComplete: true,
			executionStarted: true,
		});
		// Host order: the call renderer runs first and stores its view, then the result renderer
		// hides it in place, so one updateDisplay pass shows one header.
		const runningCall = renderers.renderCall!(running.args, plainTheme, running);
		const partial = renderers.renderResult!(
			{
				content: [{ type: "text", text: "" }],
				details: {
					calls: [{ id: "1", name: "agent_get", args: '{"id":"agent-1"}', status: "running" }],
				},
			},
			{ expanded: false, isPartial: true },
			plainTheme,
			running,
		);
		const runningLines = [...runningCall.render(80), ...partial.render(80)];
		expect(runningLines.filter((line) => line.includes("codemode"))).toEqual([
			expect.stringContaining("codemode 1 call"),
		]);
		expect(runningLines.join("\n")).not.toContain("◐ codemode");
		expect(runningLines.join("\n")).toContain("◐ agent_get");

		const failedCall = renderers.renderCall!(running.args, plainTheme, running);
		const failed = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script failed\nWall time 0.0 seconds\nOutput:\nboom" }],
				details: { calls: [] },
				isError: true,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({ state, isError: true }),
		);
		const failedLines = [...failedCall.render(80), ...failed.render(80)];
		expect(failedLines.filter((line) => line.includes("✗ codemode"))).toEqual([
			expect.stringContaining("✗ codemode 0ms"),
		]);

		const toolFailed = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script failed\nWall time 0.0 seconds\nOutput:\nboom" }],
				details: {
					calls: [
						{ id: "1", name: "edit", args: '{"path":"a.ts"}', status: "error", error: "boom" },
					],
				},
				isError: true,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({ state: {}, isError: true }),
		);
		const toolFailedLines = toolFailed.render(80);
		expect(toolFailedLines[0]).not.toContain("✗ codemode");
		expect(toolFailedLines.join("\n")).toContain("✗ edit");

		const reloaded = {};
		const reloadedContext = createMockContext({
			state: reloaded,
			args: { code: "await tools.edit({ path: 'a.ts' });" },
			executionStarted: false,
			isPartial: false,
			argsComplete: true,
		});
		const reloadedCall = renderers.renderCall!(reloadedContext.args, plainTheme, reloadedContext);
		const reloadedResult = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.0 seconds\nOutput:\ndone" }],
				details: {
					calls: [{ id: "1", name: "edit", args: 'path: "a.ts"', status: "ok", durationMs: 2 }],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			reloadedContext,
		);
		const reloadedLines = [...reloadedCall.render(80), ...reloadedResult.render(80)];
		expect(reloadedLines.filter((line) => line.includes("codemode"))).toEqual([
			expect.stringContaining("codemode 1 call"),
		]);
		expect(reloadedLines.join("\n")).toContain("✓ edit");
	});

	test("nested file-tool rows keep their tool name when codemode records JSON args", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const resultView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nok" }],
				details: {
					calls: [
						{
							id: "1",
							name: "read",
							args: '{"path":"x/renderer.ts"}',
							status: "ok",
							durationMs: 1,
						},
						{
							id: "2",
							name: "write",
							args: '{"path":"b.ts","content":"x"}',
							status: "ok",
							durationMs: 2,
						},
					],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({ state: {} }),
		) as ToolView;

		const lines = resultView.render(80).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
		expect(lines.join("\n")).toContain("▎ ✓ read x/renderer.ts · 1ms");
		expect(lines.join("\n")).toContain("▎ ✓ write b.ts · 2ms");
	});

	test("python_eval renders call facts, nested tool rows, and cell failure rules", () => {
		const resolve = setupResolver();
		const renderers = resolve("python_eval", () => undefined)!;
		const state = {};
		const ctx = createMockContext({
			state,
			args: {
				code: 'res = await tools.read({ path: "a.ts" }); text(res)',
				reset: true,
				timeout_ms: 30000,
			},
			durationMs: 200,
		});

		const success = renderers.renderResult!(
			{
				content: [{ type: "text", text: "hello\nresult: 42" }],
				details: {
					format: "pi-ext-tools-python-eval",
					rows: [
						{ kind: "text", text: "hello" },
						{
							kind: "tool",
							trace: { name: "read", args: { path: "a.ts" }, text: "body", durationMs: 5 },
						},
						{ kind: "result", text: "42" },
					],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		const level0 = success.render(80);
		expect(level0[0]).toContain("▸ python_eval (reset) · (timeout 30s) · 1 call · 200ms");
		expect(level0[0]).not.toContain("✓");
		expect(level0.join("\n")).toContain("✓ read a.ts");

		success.toggle(false);
		const level1 = success.render(80);
		expect(level1.join("\n")).toContain("res = await tools.read");
		expect(level1.join("\n")).toContain("hello");
		expect(level1.join("\n")).toContain("result: 42");

		const cellFailed = renderers.renderResult!(
			{
				content: [{ type: "text", text: "error: boom" }],
				details: {
					format: "pi-ext-tools-python-eval",
					rows: [{ kind: "text", text: "error: boom" }],
					error: "boom",
				},
				isError: true,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({ state: {}, args: { code: "1/0" }, isError: true, durationMs: 10 }),
		) as ToolView;
		expect(cellFailed.render(80)[0]).toContain("✗ python_eval");

		const toolFailed = renderers.renderResult!(
			{
				content: [{ type: "text", text: "error: read: boom" }],
				details: {
					format: "pi-ext-tools-python-eval",
					rows: [
						{
							kind: "tool",
							trace: {
								name: "edit",
								args: { path: "a.ts" },
								text: "",
								durationMs: 3,
								error: "boom",
							},
						},
					],
					error: "read: boom",
				},
				isError: true,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({
				state: {},
				args: { code: "await tools.edit" },
				isError: true,
				durationMs: 30,
			}),
		) as ToolView;
		const toolFailedLines = toolFailed.render(80);
		expect(toolFailedLines[0]).not.toContain("✗ python_eval");
		expect(toolFailedLines.join("\n")).toContain("✗ edit a.ts");
	});

	test("formatTurnFlow produces clean linear [User] / [Tools] / [Assistant] text without forced markdown", () => {
		const flow = formatTurnFlow({
			userPrompt: "Check the build",
			toolCalls: [
				{ toolName: "bash", commandOrArgs: "$ pnpm build", summary: "Exit 0 · 1.2s" },
				{ toolName: "codemode", summary: "4 calls · 2.1s" },
			],
			assistantReply: "All packages built cleanly.",
		});

		expect(flow).toBe(
			[
				"[User]",
				"Check the build",
				"",
				"[Tools]",
				"bash $ pnpm build",
				"Exit 0 · 1.2s",
				"",
				"codemode",
				"4 calls · 2.1s",
				"",
				"[Assistant]",
				"All packages built cleanly.",
			].join("\n"),
		);
	});

	test("expands tab characters to two spaces in rendered view while preserving copy text", async () => {
		const copied: string[] = [];
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode" },
			sections: [
				{
					railToken: "muted",
					content: ["\tconst x = 1;", "function foo() {\n\t\treturn true;\n}"],
				},
			],
			copy: {
				primary: "\tconst x = 1;",
				full: "\tconst x = 1;\n\t\treturn true;",
			},
			copyToClipboard: async (text) => {
				copied.push(text);
			},
			defaultLevel: 1,
		});
		const rendered = view.render(80);
		expect(rendered.join("\n")).toContain("  const x = 1;");
		expect(rendered.join("\n")).toContain("    return true;");
		expect(rendered.join("\n")).not.toContain("\t");

		// Click copy icon (width 80 -> copy icon at x = 77)
		view.handleMouse(createMouseClick(77, 0, { width: 80 }));
		expect(copied).toEqual(["\tconst x = 1;"]);

		// Shift+Click copy icon for full text
		view.handleMouse(createMouseClick(77, 0, { width: 80, shift: true }));
		expect(copied).toEqual(["\tconst x = 1;", "\tconst x = 1;\n\t\treturn true;"]);
	});

	test("applies outputPad horizontal padding to rendered lines and mouse clicks", () => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "bash", summary: "echo ok" },
			outputPad: 2,
			defaultLevel: 0,
		});
		const rendered = view.render(80);
		expect(rendered[0]).toMatch(/^ {2}▸ ✓ bash echo ok/);

		// Clicking inside padding (x < 2) should not toggle
		expect(view.handleMouse(createMouseClick(1, 0, { width: 80 }))).toBeUndefined();
		expect(view.foldLevel).toBe(0);

		// Clicking past padding (x >= 2) should toggle
		expect(view.handleMouse(createMouseClick(5, 0, { width: 80 }))).toEqual({
			handled: true,
			render: true,
		});
		expect(view.foldLevel).toBe(1);
	});

	test("codemode nested calls: individual tool copy and click-to-expand without extra rail", () => {
		clearCapturedNestedCalls();
		const copied: string[] = [];
		const resolve = setupResolver({
			copyToClipboard: async (text) => {
				copied.push(text);
			},
		});
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-code-parent";

		// Simulate live execution events captured for two child tools
		recordToolExecutionStart({
			toolCallId: "child-1",
			toolName: "bash",
			args: { command: "echo hello" },
			parentToolCallId: parentCallId,
		});
		recordToolExecutionEnd({
			toolCallId: "child-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "hello output\nline 2" }],
				details: {},
			},
			isError: false,
			durationMs: 45,
			parentToolCallId: parentCallId,
		});

		recordToolExecutionStart({
			toolCallId: "child-2",
			toolName: "write",
			args: { path: "src/new.ts", content: "export const x = 42;" },
			parentToolCallId: parentCallId,
		});
		recordToolExecutionEnd({
			toolCallId: "child-2",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "wrote 20 bytes" }],
				details: {},
			},
			isError: false,
			durationMs: 12,
			parentToolCallId: parentCallId,
		});

		const ctx = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.bash({ command: "echo hello" });' },
		});

		const resultView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\ndone" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		const rows = resultView.render(80);
		// Header has NO copy button
		expect(rows[0]).not.toContain("󰆏");
		expect(rows[0]).toContain("▸ codemode 2 calls");

		// Child rows have individual copy icons and no arrow prefix
		expect(rows[1]).toContain("▎ ✓ bash echo hello · 45ms");
		expect(rows[1]).toContain("󰆏");
		expect(rows[2]).toContain("▎ ✓ write src/new.ts · 12ms");
		expect(rows[2]).toContain("󰆏");

		// Click child 1 copy button (row 1, x=78)
		resultView.handleMouse(createMouseClick(78, 1, { width: 80 }));
		expect(copied.at(-1)).toBe("echo hello");

		// Shift-click child 1 copy button: command plus output
		resultView.handleMouse(createMouseClick(78, 1, { width: 80, shift: true }));
		expect(copied.at(-1)).toBe("echo hello\n---\nhello output\nline 2");

		// Click child 2 copy button (row 2, x=78)
		resultView.handleMouse(createMouseClick(78, 2, { width: 80 }));
		expect(copied.at(-1)).toBe("export const x = 42;");

		// Click child 1 row body (row 1, x=10) to expand it
		resultView.handleMouse(createMouseClick(10, 1, { width: 80 }));
		const expandedRows = resultView.render(80);

		// Child 1 header has no arrow prefix
		expect(expandedRows[1]).toContain("▎ ✓ bash echo hello · 45ms");
		// Child 1 uses ext-ui upper room ($ echo hello) and lower room (output lines)
		expect(expandedRows[2]).toContain("▎   $ echo hello");
		expect(expandedRows[3]).toContain("▎   hello output");
		expect(expandedRows[4]).toContain("▎   line 2");
		// Confirm NO duplicate rail glyphs
		expect(expandedRows[2]).not.toMatch(/▎.*▎/);
		expect(expandedRows[3]).not.toMatch(/▎.*▎/);
	});
	test("success tools and codemode use success rail color when expanded and collapsed", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-code-success-test";

		// Child tool failed, but script itself caught it or completed without error (isError: false)
		recordToolExecutionStart({
			toolCallId: "child-err",
			toolName: "read",
			args: { path: "nonexistent.ts" },
			parentToolCallId: parentCallId,
		});
		recordToolExecutionEnd({
			toolCallId: "child-err",
			toolName: "read",
			result: { content: [{ type: "text", text: "file not found" }], details: {} },
			isError: true,
			durationMs: 10,
			parentToolCallId: parentCallId,
		});

		const ctx = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.read({ path: "nonexistent.ts" }).catch(() => null);' },
			isError: false,
		});

		// 1. Successful codemode (isError: false)
		const successView = renderers.renderResult!(
			{
				content: [
					{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nhandled" },
				],
				details: {},
				isError: false,
			},
			{ expanded: false, isPartial: false },
			taggedTheme,
			ctx,
		) as ToolView;

		// Level 0: collapsed state rail keeps theme default (dim), not success
		const level0 = successView.render(80);
		expect(level0[1]).toContain("[dim:▎]");

		// Level 1: expand codemode -> upper room (code) is muted, lower room (output) is success
		successView.setFoldLevel(1);
		const level1 = successView.render(80);
		expect(level1[1]).toContain("[muted:▎]");
		expect(level1[level1.length - 1]).toContain("[success:▎]");

		// 2. Failed codemode (script itself crashed, isError: true)
		const failedCtx = createMockContext({
			toolCallId: "call-code-fail-test",
			args: { code: 'throw new Error("boom");' },
			isError: true,
		});
		const failedView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script failed\nOutput:\nboom" }],
				details: {},
				isError: true,
			},
			{ expanded: false, isPartial: false },
			taggedTheme,
			failedCtx,
		) as ToolView;

		failedView.setFoldLevel(1);
		const failedLevel1 = failedView.render(80);
		expect(failedLevel1[1]).toContain("[muted:▎]");
		expect(failedLevel1[failedLevel1.length - 1]).toContain("[error:▎]");
	});

	test("expanding codemode folds any previously expanded child tools first", () => {
		clearCapturedNestedCalls();
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-code-fold-test";

		recordToolExecutionStart({
			toolCallId: "child-step1",
			toolName: "bash",
			args: { command: "echo step1" },
			parentToolCallId: parentCallId,
		});
		recordToolExecutionEnd({
			toolCallId: "child-step1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "line A\nline B" }],
				details: {},
			},
			isError: false,
			durationMs: 25,
			parentToolCallId: parentCallId,
		});

		const ctx = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.bash({ command: "echo step1" });' },
		});

		const resultView = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1s\nOutput:\nok" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		// Level 0: initial render
		const initial = resultView.render(80);
		expect(initial[1]).toContain("▎ ✓ bash echo step1");

		// 1. Expand child tool first at Level 0
		resultView.handleMouse(createMouseClick(10, 1, { width: 80 }));
		const childExpanded = resultView.render(80);
		expect(childExpanded[1]).toContain("▎ ✓ bash echo step1");
		expect(childExpanded[2]).toContain("▎   $ echo step1");
		expect(childExpanded[3]).toContain("▎   line A");

		// 2. Now expand codemode itself (clicking codemode header at y=0)
		resultView.handleMouse(createMouseClick(2, 0, { width: 80 }));
		const codemodeExpanded = resultView.render(80);

		// In expanded codemode: codemode header is ▾
		expect(codemodeExpanded[0]).toContain("▾ codemode");
		// Child nested tool calls are hidden when parent is expanded
		expect(codemodeExpanded.join("\n")).not.toContain("bash echo step1");
		expect(codemodeExpanded.join("\n")).not.toContain("line A");

		// 3. Fold codemode back to Level 0
		resultView.handleMouse(createMouseClick(2, 0, { width: 80 }));
		const foldedBack = resultView.render(80);
		expect(foldedBack[0]).toContain("▸ codemode");
		expect(foldedBack[1]).toContain("▎ ✓ bash echo step1");
		expect(foldedBack.join("\n")).not.toContain("line A");
	});
	test("heavy inputs in codemode and bash apply syntax highlighting in Level 1", () => {
		const resolve = setupResolver({ tools: ["codemode", "bash"] });
		const codemodeRenderers = resolve("codemode", () => undefined)!;
		const bashRenderers = resolve("bash", () => undefined)!;

		// 1. codemode: script code highlighted as javascript
		const cmCtx = createMockContext({
			args: { code: "const val = 123;\nreturn val > 0;" },
		});
		const cmView = codemodeRenderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1s\nOutput:\ntrue" }],
				details: { calls: [] },
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			cmCtx,
		) as ToolView;

		cmView.setFoldLevel(1);
		const cmRendered = cmView.render(80);
		expect(cmRendered.join("\n")).toContain("const val = 123;");
		expect(cmRendered.join("\n")).toContain("return val > 0;");

		// 2. bash: shell command highlighted with $ prefix
		const bashCtx = createMockContext({
			args: { command: 'echo "hello world"' },
		});
		const bashView = bashRenderers.renderResult!(
			{
				content: [{ type: "text", text: "hello world" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			bashCtx,
		) as ToolView;

		bashView.setFoldLevel(1);
		const bashRendered = bashView.render(80);
		expect(bashRendered.join("\n")).toContain('$ echo "hello world"');

		// 3. bash with taggedTheme: header and input command are unstyled (no themes), while output is dim
		const taggedBashView = bashRenderers.renderResult!(
			{
				content: [{ type: "text", text: "hello world" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			taggedTheme,
			bashCtx,
		) as ToolView;
		taggedBashView.setFoldLevel(1);
		const taggedRendered = taggedBashView.render(80);
		// Upper room command has plain $ prefix without accent theme
		expect(taggedRendered.join("\n")).toContain('$ echo "hello world"');
		expect(taggedRendered.join("\n")).not.toContain("[accent:$]");
		// Header summary is unstyled for bash
		expect(taggedRendered[0]).not.toContain('[dim:echo "hello world"]');
		// Lower room output is dim
		expect(taggedRendered.join("\n")).toContain("[dim:hello world]");
	});

	test("ToolView.invalidate on codemode result with nested calls does not trigger recursive host invalidate loop", () => {
		const resolve = setupResolver({ tools: ["codemode"] });
		const codemodeRenderers = resolve("codemode", () => undefined)!;

		let viewInstance: ToolView | undefined;
		let hostInvalidateCallCount = 0;

		const ctx = createMockContext({
			args: { code: 'await tools.read({ path: "a.ts" });' },
			invalidate: () => {
				hostInvalidateCallCount++;
				// Simulates Pi host ToolExecutionComponent: calling context.invalidate()
				// causes the host component to invalidate its children downward.
				viewInstance?.invalidate();
			},
		});

		const resultView = codemodeRenderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed" }],
				details: {
					calls: [{ id: "1", name: "read", args: '{"path":"a.ts"}', status: "ok" }],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;
		viewInstance = resultView;

		// Downward invalidation from host must not trigger upward context.invalidate() recursion
		expect(() => {
			resultView.invalidate();
		}).not.toThrow();
		expect(hostInvalidateCallCount).toBe(0);
	});

	test("stateHolder persists expanded nested tools across re-render cycles", () => {
		clearCapturedNestedCalls();
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-persist-test";

		recordToolExecutionStart({
			toolCallId: "child-persist-1",
			toolName: "read",
			args: { path: "src/file.ts" },
			parentToolCallId: parentCallId,
		});
		recordToolExecutionEnd({
			toolCallId: "child-persist-1",
			toolName: "read",
			result: {
				content: [{ type: "text", text: "line 100\nline 200" }],
				details: {},
			},
			isError: false,
			durationMs: 15,
			parentToolCallId: parentCallId,
		});

		const sharedState: Record<string, unknown> = {};
		const ctx1 = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.read({ path: "src/file.ts" });' },
			state: sharedState,
		});

		// Turn 1: initial render
		const view1 = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1s\nOutput:\nok" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx1,
		) as ToolView;

		const lines1 = view1.render(80);
		expect(lines1.join("\n")).not.toContain("line 100");

		// Click child 1 body at row 1 to expand
		view1.handleMouse(createMouseClick(10, 1, { width: 80 }));
		const lines1Expanded = view1.render(80);
		expect(lines1Expanded.join("\n")).toContain("line 100");

		// Turn 2: Pi re-renders transcript (new component instance with same stateHolder)
		const ctx2 = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.read({ path: "src/file.ts" });' },
			state: sharedState,
		});
		const view2 = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.1s\nOutput:\nok" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx2,
		) as ToolView;

		// Expanded state survived across component re-creation!
		const lines2 = view2.render(80);
		expect(lines2.join("\n")).toContain("line 100");
	});

	test("ctrl+click on child tool fully expands it to Level 2", () => {
		clearCapturedNestedCalls();
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const parentCallId = "call-ctrl-test";

		const manyLines = Array.from({ length: 40 }, (_, i) => `output line ${String(i + 1)}`).join(
			"\n",
		);
		recordToolExecutionStart({
			toolCallId: "child-ctrl-1",
			toolName: "bash",
			args: { command: "generate-lines" },
			parentToolCallId: parentCallId,
		});
		recordToolExecutionEnd({
			toolCallId: "child-ctrl-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: manyLines }],
				details: {},
			},
			isError: false,
			durationMs: 30,
			parentToolCallId: parentCallId,
		});

		const ctx = createMockContext({
			toolCallId: parentCallId,
			args: { code: 'await tools.bash({ command: "generate-lines" });' },
		});

		const view = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed" }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		// Initial render populates layout line map
		view.render(80);

		// 1. Normal click expands to Level 1
		view.handleMouse(createMouseClick(10, 1, { width: 80 }));
		const level1Lines = view.render(80);
		expect(level1Lines.join("\n")).toContain("output line 1");
		// In level 1, sections or output are capped with omission hint
		expect(level1Lines.join("\n")).toMatch(/(omitted|more lines)/);

		// 2. Ctrl+click expands to Level 2 (unlimited lines)
		view.handleMouse(createMouseClick(10, 1, { width: 80, ctrl: true }));
		const level2Lines = view.render(80);
		expect(level2Lines.join("\n")).toContain("output line 1");
		expect(level2Lines.join("\n")).toContain("output line 40");
		expect(level2Lines.join("\n")).not.toMatch(/(omitted|more lines)/);
	});

	test("ToolView.renderBody renders body lines headless without header and supports noRail option", () => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "bash", status: "ok", summary: "echo test" },
			sections: [
				{
					railToken: "success",
					content: ["hello line 1", "hello line 2"],
				},
			],
			defaultLevel: 1,
		});

		// 1. Full render includes header row and rails
		const full = view.render(80);
		expect(full[0]).toContain("▾ ✓ bash");
		expect(full[1]).toContain("▎ hello line 1");

		// 2. renderBody without options renders body with rails, but NO header row
		const bodyWithRail = view.renderBody(80);
		expect(bodyWithRail).toHaveLength(2);
		expect(bodyWithRail[0]).not.toContain("bash");
		expect(bodyWithRail[0]).toContain("▎ hello line 1");
		expect(bodyWithRail[1]).toContain("▎ hello line 2");

		// 3. renderBody with noRail: true omits rail glyphs cleanly
		const headlessNoRail = view.renderBody(80, { noRail: true });
		expect(headlessNoRail).toHaveLength(2);
		expect(headlessNoRail[0]).toBe("hello line 1");
		expect(headlessNoRail[1]).toBe("hello line 2");
		expect(headlessNoRail[0]).not.toContain("▎");
	});

	test("ToolView supports controlledLevel and safe stateHolder: undefined memory mode", () => {
		const state: Record<string, unknown> = { __piExtUiFoldLevel: 0 };
		const controlledView = new ToolView({
			theme: plainTheme,
			header: { title: "read", status: "ok" },
			sections: [{ railToken: "dim", content: ["data line"] }],
			controlledLevel: 2,
			stateHolder: state,
		});

		// 1. controlledLevel takes precedence over stateHolder
		expect(controlledView.foldLevel).toBe(2);
		expect(controlledView.effectiveLevel).toBe(2);

		// 2. setFoldLevel in controlled mode does NOT overwrite stateHolder
		controlledView.setFoldLevel(1);
		expect(state.__piExtUiFoldLevel).toBe(0);

		// 3. stateHolder: undefined operates purely in-memory without error
		const memoryView = new ToolView({
			theme: plainTheme,
			header: { title: "read", status: "ok" },
			sections: [{ railToken: "dim", content: ["memory line"] }],
			defaultLevel: 0,
			stateHolder: undefined,
		});
		expect(memoryView.foldLevel).toBe(0);
		memoryView.setFoldLevel(1);
		expect(memoryView.foldLevel).toBe(1);
	});

	test("isCollapsible type-guard and collapsibleChildren explicit composite hierarchy", () => {
		expect(isCollapsible(null)).toBe(false);
		expect(isCollapsible(undefined)).toBe(false);
		expect(isCollapsible("string")).toBe(false);
		expect(isCollapsible({})).toBe(false);
		expect(isCollapsible({ collapseAll: 123 })).toBe(false);

		const dummyCollapsible: Collapsible = { collapseAll: vi.fn() };
		expect(isCollapsible(dummyCollapsible)).toBe(true);

		const child1: Collapsible = { collapseAll: vi.fn() };
		const child2: Collapsible = { collapseAll: vi.fn() };

		const parent = new ToolView({
			theme: plainTheme,
			header: { title: "parent", status: "ok" },
			collapsedRows: child1 as unknown as Component,
			collapsibleChildren: [child2],
			defaultLevel: 0,
		});

		// Expanding parent from 0 to 1 collapses both registered children
		parent.setFoldLevel(1);
		expect(child1.collapseAll).toHaveBeenCalledTimes(1);
		expect(child2.collapseAll).toHaveBeenCalledTimes(1);
	});

	test("NestedCallsView fold transitions follow shared state machine (2 -> 0 on normal click) and dispose cleans up timer", () => {
		const state: Record<string, unknown> = {};
		const ncv = new NestedCallsView({
			calls: [
				{
					id: "call-1",
					toolName: "bash",
					args: { command: "ls -la" },
					result: { content: [{ type: "text", text: "file.txt" }], details: {} },
				},
			],
			theme: plainTheme,
			context: createMockContext(),
			stateHolder: state,
		});

		// Render to generate lineMapping
		ncv.render(80);

		// 1. Click row 0 -> transitions from Level 0 to Level 1
		const res1 = ncv.handleMouse(createMouseClick(10, 0, { width: 80 }));
		expect(res1?.handled).toBe(true);
		expect((state[NESTED_CALLS_EXPANDED_KEY] as Record<string, number>)["0"]).toBe(1);

		// 2. Click row 0 again -> transitions from Level 1 to Level 0
		ncv.render(80);
		const res2 = ncv.handleMouse(createMouseClick(10, 0, { width: 80 }));
		expect(res2?.handled).toBe(true);
		expect((state[NESTED_CALLS_EXPANDED_KEY] as Record<string, number>)["0"]).toBeUndefined();

		// 3. Ctrl-click row 0 -> transitions from Level 0 to Level 2
		ncv.render(80);
		const res3 = ncv.handleMouse(createMouseClick(10, 0, { width: 80, ctrl: true }));
		expect(res3?.handled).toBe(true);
		expect((state[NESTED_CALLS_EXPANDED_KEY] as Record<string, number>)["0"]).toBe(2);

		// 4. Normal click row 0 while at Level 2 -> MUST transition to Level 0 (not 1)
		ncv.render(80);
		const res4 = ncv.handleMouse(createMouseClick(10, 0, { width: 80, ctrl: false }));
		expect(res4?.handled).toBe(true);
		expect((state[NESTED_CALLS_EXPANDED_KEY] as Record<string, number>)["0"]).toBeUndefined();

		// 5. Calling dispose is safe and cleans up resources
		expect(() => ncv.dispose()).not.toThrow();
	});

	test("NestedCallsView retains ANSI escape colors and syntax highlights file reads", () => {
		const state: Record<string, unknown> = {};
		const ncv = new NestedCallsView({
			calls: [
				{
					id: "call-ansi",
					toolName: "bash",
					args: { command: "npm test" },
					result: {
						content: [{ type: "text", text: "\x1b[32mPASS\x1b[0m test/suite.js" }],
						details: {},
					},
				},
				{
					id: "call-read",
					toolName: "read",
					args: { path: "server.ts" },
					result: {
						content: [{ type: "text", text: "const port = 3000;" }],
						details: {},
					},
				},
			],
			theme: plainTheme,
			context: createMockContext(),
			stateHolder: state,
		});

		// Expand row 0 (bash)
		ncv.render(80);
		ncv.handleMouse(createMouseClick(10, 0, { width: 80 }));
		const linesWithAnsi = ncv.render(80);
		// Output line should preserve the ANSI color escape sequence
		expect(linesWithAnsi.some((l) => l.includes("\x1b[32mPASS\x1b[0m"))).toBe(true);

		// Expand row 1 (read server.ts)
		ncv.handleMouse(createMouseClick(10, 2, { width: 80 }));
		const linesWithRead = ncv.render(80);
		// Output lines should contain the code line
		expect(linesWithRead.some((l) => l.includes("const port = 3000;"))).toBe(true);
	});

	test("NestedCallsView absorbs clicks on body and unmapped lines without bubbling undefined", () => {
		const state: Record<string, unknown> = {};
		const ncv = new NestedCallsView({
			calls: [
				{
					id: "call-1",
					toolName: "bash",
					args: { command: "seq 1 5" },
					result: {
						content: [{ type: "text", text: "1\n2\n3\n4\n5" }],
						details: {},
					},
				},
				{
					id: "call-2",
					toolName: "bash",
					args: { command: "echo hello" },
					result: {
						content: [{ type: "text", text: "hello" }],
						details: {},
					},
				},
			],
			theme: plainTheme,
			context: createMockContext(),
			stateHolder: state,
		});

		// 1. Initial collapsed render has 2 lines: header for call-1, header for call-2
		const initLines = ncv.render(80);
		expect(initLines).toHaveLength(2);

		// 2. Expand call-1 by clicking row 0
		ncv.handleMouse(createMouseClick(10, 0, { width: 80 }));
		const expLines = ncv.render(80);
		expect(expLines.length).toBeGreaterThan(2);

		// 3. Click on a body line (e.g. row 2 which is part of call-1 body)
		// MUST return handled: true so it never bubbles to outer container MouseRegion
		const bodyClickRes = ncv.handleMouse(createMouseClick(10, 2, { width: 80 }));
		expect(bodyClickRes).toEqual({ handled: true });

		// 4. Click on an out-of-bounds / unmapped row
		const outClickRes = ncv.handleMouse(createMouseClick(10, 99, { width: 80 }));
		expect(outClickRes).toEqual({ handled: true });

		// 5. Collapse call-1 by clicking row 0 again
		const collapseRes = ncv.handleMouse(createMouseClick(10, 0, { width: 80 }));
		expect(collapseRes?.handled).toBe(true);

		// 6. After collapsing call-1, call-2 remains cleanly visible at row 1
		const collapsedLines = ncv.render(80);
		expect(collapsedLines).toHaveLength(2);
		expect(collapsedLines[0]).toContain("seq 1 5");
		expect(collapsedLines[1]).toContain("echo hello");
	});

	test("ToolView absorbs clicks within its rendered boundaries without bubbling to outer MouseRegion", () => {
		const invalidate = vi.fn();
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", summary: "2 calls" },
			sections: [{ railToken: "dim", content: ["output line 1", "output line 2"] }],
			invalidate,
		});

		view.setFoldLevel(1);
		const lines = view.render(80);
		expect(lines).toHaveLength(3);

		// Click on body line (row 1)
		const bodyClick = view.handleMouse(createMouseClick(10, 1, { width: 80 }));
		expect(bodyClick).toEqual({ handled: true });

		// Click outside vertical bounds (row 10)
		const outsideClick = view.handleMouse(createMouseClick(10, 10, { width: 80 }));
		expect(outsideClick).toBeUndefined();
	});

	test("NestedCallsView and ToolView sanitize multiline commands into strict single-line elements", () => {
		const multilineCommand = "ssh dcu-cluster '\n  export PATH=/opt/bin:$PATH\n  cmake --build build\n'";
		const ncv = new NestedCallsView({
			calls: [
				{
					id: "call-multi",
					toolName: "bash",
					args: { command: multilineCommand },
					result: {
						content: [{ type: "text", text: "done" }],
						details: {},
					},
				},
				{
					id: "call-next",
					toolName: "bash",
					args: { command: "ls -l" },
					result: {
						content: [{ type: "text", text: "bin" }],
						details: {},
					},
				},
			],
			theme: plainTheme,
			context: createMockContext(),
		});

		const rendered = ncv.render(80);
		expect(rendered).toHaveLength(2);
		for (const line of rendered) {
			expect(line).not.toContain("\n");
			expect(line).not.toContain("\r");
		}

		const tv = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", summary: "multiline\nheader\r\ntest" },
			collapsedRows: ncv,
		});

		const tvLines = tv.render(80);
		expect(tvLines).toHaveLength(3);
		for (const line of tvLines) {
			expect(line).not.toContain("\n");
			expect(line).not.toContain("\r");
		}
	});

	test("A board row stays one row: breaks collapse, they do not split the element", () => {
		// Pi writes one array element as one terminal row, so a break inside a label would silently
		// push the frame past the rows it reports. It is one row, one label.
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "bash", status: "ok", summary: "progress 10%\rprogress 90%" },
			collapsedRows: ["a\rb", "c\r\nd", "e\nf"],
			defaultLevel: 0,
		});

		const rows = view.render(80);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toContain("progress 10% progress 90%");
		expect(rows[1]).toContain("a b");
		expect(rows[2]).toContain("c d");
		expect(rows[3]).toContain("e f");
		for (const row of rows) {
			expect(row).not.toMatch(/[\r\n]/);
		}
	});

	test("Section content splits into rows and a lone CR is dropped, not treated as a break", () => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "bash", status: "ok", summary: "exit 0" },
			sections: [{ railToken: "dim", content: ["progress 10%\rprogress 90%", "next"] }],
			defaultLevel: 1,
		});

		const rows = view.render(80);
		expect(rows).toHaveLength(3);
		// A lone CR returns to column 0; dropping it keeps the row instead of overwriting its start.
		expect(rows[1]).toContain("progress 10%progress 90%");
		expect(rows[2]).toContain("next");
		for (const row of rows) {
			expect(row).not.toMatch(/[\r\n]/);
		}
	});

	test("Component rows keep their own indentation while losing their breaks", () => {
		// A component already laid its rows out; only the breaks are removed, so the indent inside a
		// collapsed board survives and the section does not re-trim it.
		const inner = new NestedCallsView({
			calls: [
				{
					id: "call-indent",
					toolName: "bash",
					args: { command: "echo step1" },
					result: { content: [{ type: "text", text: "  $ echo step1\n  line A" }], details: {} },
				},
			],
			theme: plainTheme,
			context: createMockContext(),
			stateHolder: {},
		});
		inner.render(80);
		inner.handleMouse(createMouseClick(10, 0, { width: 80 }));

		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", status: "none", summary: "1 call" },
			collapsedRows: inner,
			defaultLevel: 0,
		});

		// Row 1 is the nested row's own header; its body keeps the two-space indent the component
		// rendered, on top of the shared rail.
		const rows = view.render(80);
		expect(rows).toHaveLength(4);
		expect(rows[2]).toContain("▎   $ echo step1");
		expect(rows[3]).toContain("line A");
		expect(rows[3]).toContain("▎     line A");
	});

	test("A hidden view rejects clicks instead of toggling from stale geometry", () => {
		const invalidate = vi.fn();
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", status: "none", summary: "1 call" },
			sections: [{ railToken: "dim", content: ["output line 1"] }],
			defaultLevel: 1,
			invalidate,
		});

		view.render(80);
		view.hide();
		expect(view.render(80)).toHaveLength(0);

		// The call view stays mounted under its result view, so a click now belongs to the result
		// renderer, and the hidden view must not consume it or flip its own fold state.
		expect(view.handleMouse(createMouseClick(5, 0, { width: 80 }))).toBeUndefined();
		expect(view.foldLevel).toBe(1);
		expect(invalidate).not.toHaveBeenCalled();
	});

	test("python_eval fallback row keeps a multi-line argument on one row", () => {
		const resolve = setupResolver();
		const renderers = resolve("python_eval", () => undefined)!;
		// `args` arrives as a raw string when argument validation failed, so the row has no inline
		// presentation to lean on and must normalize the text itself.
		const details = {
			format: "pi-ext-tools-python-eval",
			rows: [
				{
					kind: "tool",
					trace: { name: "cmd", args: "l1\nl2\nl3", text: "", durationMs: 5, error: "bad" },
				},
			],
		};
		const ctx = createMockContext({ args: { code: "x" } });
		const view = renderers.renderResult!(
			{ content: [{ type: "text", text: "" }], details } as never,
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		);

		const rows = view.render(190);
		expect(rows.some((row) => row.includes("cmd l1 l2 l3"))).toBe(true);
		for (const row of rows) {
			expect(row).not.toMatch(/[\r\n]/);
		}
	});

	test("A normalized header stays one row and keeps the copy icon in its slot at any width", () => {
		// The copy icon is positioned from the row's measured width, so a break smuggled into the
		// header used to shorten the measured row and let the icon drift into the body's columns.
		const multiLine =
			"ssh dcu-cluster '\n  export PATH=/opt/bin:$PATH\n  srun -p fast bash -c \"hy-smi\"\n'";
		for (const width of [6, 7, 12, 20, 41, 42, 80, 120, 190, 200]) {
			const view = new ToolView({
				theme: plainTheme,
				header: { title: "bash", summary: multiLine },
				sections: [{ railToken: "dim", content: [multiLine] }],
				defaultLevel: 1,
				copy: { primary: "cmd" },
				outputPad: 1,
			});

			const rows = view.render(width);
			for (const row of rows) {
				expect(row).not.toMatch(/[\r\n]/);
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		}

		const header = new ToolView({
			theme: plainTheme,
			header: { title: "bash", summary: "a\nb" },
			copy: { primary: "cmd" },
		}).render(40)[0]!;
		expect(visibleWidth(header)).toBe(40);
		expect(header).toContain("bash a b");
		expect(header.trimEnd().endsWith("󰆏")).toBe(true);
	});
});
