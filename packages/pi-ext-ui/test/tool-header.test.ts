import type { ExtensionAPI, Theme, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { createToolPresentationRenderers, textToolResult } from "@hheei/pi-ext-core";
import { describe, expect, test, vi } from "vitest";
import {
	formatToolHeaderText,
	registerCollapsibleToolRenderer,
	type ToolRenderContext,
	type ToolView,
} from "../src/index.js";

/** A theme that spells out every token, so a color that changes shows up as a changed string. */
const theme = {
	fg: (token: string, text: string) => `[${token}]${text}[/]`,
	bold: (text: string) => `*${text}*`,
} as unknown as Theme;

function context(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args: {},
		state: {},
		toolCallId: "parent",
		cwd: "/repo",
		invalidate: vi.fn(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		lastComponent: undefined,
		durationMs: 120,
		outputPad: 0,
		...overrides,
	};
}

function host() {
	let resolver: ToolRendererResolver | undefined;
	const pi = {
		events: {},
		registerToolRenderer(value: ToolRendererResolver) {
			resolver = value;
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		register() {
			registerCollapsibleToolRenderer(pi, { copyToClipboard: vi.fn(async () => {}) });
		},
		resolve(name: string, native?: never) {
			if (resolver === undefined) throw new Error("no UI registered");
			return resolver(name, () => native)!;
		},
	};
}

describe("formatToolHeaderText", () => {
	test("gives the name the title token and the summary the muted one", () => {
		expect(formatToolHeaderText({ status: "ok", title: "read", summary: "a.ts" }, theme)).toBe(
			"[success]✓[/] [toolTitle]*read*[/] [dim]a.ts[/]",
		);
	});

	test("leaves bash's summary in the terminal default color", () => {
		// Bash output is already meaningful on its own; dimming the command would hide it.
		expect(formatToolHeaderText({ status: "ok", title: "bash", summary: "pnpm test" }, theme)).toBe(
			"[success]✓[/] [toolTitle]*bash*[/] pnpm test",
		);
	});

	test("omits the glyph slot entirely when the row reports no status", () => {
		expect(formatToolHeaderText({ status: "none", title: "codemode" }, theme)).toBe(
			"[toolTitle]*codemode*[/]",
		);
	});
});

describe("a container board row", () => {
	const cases = [
		{
			toolName: "write",
			args: { path: "src/app.ts" },
			isError: false,
			summary: "src/app.ts (+12 -3)",
		},
		{ toolName: "bash", args: { command: "pnpm test" }, isError: false, summary: "pnpm test" },
		{ toolName: "edit", args: { path: "src/other.ts" }, isError: true, summary: "src/other.ts" },
	];

	test.each(cases)("colors a nested $toolName exactly like that tool colors its own header", ({
		toolName,
		args,
		isError,
		summary,
	}) => {
		const h = host();
		h.register();
		const native = createToolPresentationRenderers(h.pi, toolName, () => ({
			summary,
			output: "payload",
		}));
		const own = h.resolve(toolName, native as never);
		const ownRow = (
			own.renderResult!(
				textToolResult("model payload", undefined),
				{ expanded: false, isPartial: false },
				theme,
				context({ toolCallId: "child", args, isError }),
			) as ToolView
		).render(120)[0];
		expect(ownRow).toBeDefined();

		const parent = h.resolve("codemode").renderResult!(
			textToolResult("", {
				__piExtUiCapturedCalls: [
					{
						toolCallId: "child",
						toolName,
						args,
						result: textToolResult("model payload", undefined),
						durationMs: 120,
						isError,
					},
				],
			}),
			{ expanded: false, isPartial: false },
			theme,
			context(),
		) as ToolView;
		const boardRow = parent.render(120)[1];
		expect(boardRow).toBeDefined();

		// The only intended difference is the fold pin: a nested row hangs off the parent's rail.
		const ownHeader = (ownRow ?? "").replace(/^\[dim\][▸▾]\[\/\] /, "");
		const boardHeader = (boardRow ?? "").replace(/^\[dim\]▎\[\/\] /, "");
		expect(boardHeader.slice(0, ownHeader.length)).toBe(ownHeader);
	});
});
