import type {
	ExtensionAPI,
	Theme,
	ToolRendererResolver,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import extension from "../src/extension.js";
import {
	formatTurnFlow,
	registerCollapsibleToolRenderer,
	SPECIALIZED_TOOL_RENDERERS,
	type ToolRenderContext,
	ToolView,
	transitionFoldLevel,
	WEB_ACCESS_TOOLS,
} from "../src/index.js";

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

	test("Level 0 caps the collapsed board rows at 6 with a dim omission hint", () => {
		const view = new ToolView({
			theme: plainTheme,
			header: { title: "codemode", status: "none", summary: "30 calls" },
			collapsedRows: Array.from({ length: 30 }, (_, i) => `✓ read a${String(i)}.ts`),
			stateHolder: {},
		});

		const level0 = view.render(80);
		expect(level0).toHaveLength(8);
		expect(level0[1]).toContain("✓ read a0.ts");
		expect(level0[6]).toContain("✓ read a5.ts");
		expect(level0[7]).toContain("… (24 more)");
		expect(level0[7]).not.toContain("read a6");
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
		expect(level0[1]).toBe('▎ ✓ read path: "a.ts" 18ms');

		resultView.handleMouse(createMouseClick(2, 0, { width: 80 }));
		const level1 = resultView.render(80);
		expect(level1[0]).toContain("▾ codemode (timeout 30s) · 1 call · 200ms");
		expect(level1[1]).toContain("// @options:");
		expect(level1.join("\n")).toContain("file content line 1");
		expect(level1.join("\n")).not.toContain("Script completed");

		resultView.handleMouse(createMouseClick(78, 0, { width: 80 }));
		expect(copied[0]).toContain("const res = await tools.read");
		expect(copied[0]).not.toContain("file content line 1");

		resultView.handleMouse(createMouseClick(78, 0, { width: 80, shift: true }));
		expect(copied[1]).toContain("const res = await tools.read");
		expect(copied[1]).toContain("file content line 1");
	});

	test("codemode keeps one header: no spinner while running, and the call row leaves once a result exists", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined)!;
		const state = {};
		const running = createMockContext({
			state,
			args: { code: "await tools.wait_jobs({ ids: ['agent-1'] });" },
			isPartial: true,
			argsComplete: true,
			executionStarted: true,
		});
		const partial = renderers.renderResult!(
			{
				content: [{ type: "text", text: "" }],
				details: {
					calls: [{ id: "1", name: "wait_jobs", args: '{"ids":["agent-1"]}', status: "running" }],
				},
			},
			{ expanded: false, isPartial: true },
			plainTheme,
			running,
		);
		const runningLines = [
			...renderers.renderCall!(running.args, plainTheme, running).render(80),
			...partial.render(80),
		];
		expect(runningLines.filter((line) => line.includes("codemode"))).toEqual([
			expect.stringContaining("codemode 1 call"),
		]);
		expect(runningLines.join("\n")).not.toContain("◐ codemode");
		expect(runningLines.join("\n")).toContain("◐ wait_jobs");

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
		const failedLines = [
			...renderers.renderCall!(running.args, plainTheme, running).render(80),
			...failed.render(80),
		];
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
							args: '{"path":"/home/chlo/x/renderer.ts"}',
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
		expect(lines.join("\n")).toContain("read /home/chlo/x/renderer.ts 1ms");
		expect(lines.join("\n")).toContain("write b.ts 2ms");
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
				timeout: 30,
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
});
