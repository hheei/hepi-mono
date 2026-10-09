import type {
	ExtensionAPI,
	Theme,
	ToolRendererResolver,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
	type DiffSource,
	DiffView,
	diffStats,
	registerCollapsibleToolRenderer,
	type ToolRenderContext,
	type ToolView,
} from "../src/index.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

const PATCH = [
	"diff --git a/src/index.ts b/src/index.ts",
	"index 111..222 100644",
	"--- a/src/index.ts",
	"+++ b/src/index.ts",
	"@@ -12,3 +12,4 @@",
	" const a = 1;",
	'-const oldVal = "foo";',
	'+const newVal = "bar";',
	"+const extra = true;",
].join("\n");

function view(source: DiffSource, theme: Theme = plainTheme): DiffView {
	return new DiffView({ theme, source });
}

function createMockContext(overrides?: Partial<ToolRenderContext>): ToolRenderContext {
	return {
		args: { path: "src/index.ts" },
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

function setupResolver(copyToClipboard?: (text: string) => Promise<void>): ToolRendererResolver {
	let captured: ToolRendererResolver | undefined;
	const pi = {
		registerToolRenderer(resolver: ToolRendererResolver) {
			captured = resolver;
		},
	} as unknown as ExtensionAPI;
	registerCollapsibleToolRenderer(pi, copyToClipboard ? { copyToClipboard } : undefined);
	if (captured === undefined) throw new Error("Expected registerToolRenderer to be called");
	return captured;
}

function clickHeader(view: ToolView): void {
	view.handleMouse({
		type: "click",
		button: "left",
		x: 2,
		y: 0,
		screenX: 2,
		screenY: 0,
		width: 80,
		height: 5,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

function clickCopy(view: ToolView, height = 5): void {
	view.handleMouse({
		type: "click",
		button: "left",
		x: 78,
		y: 0,
		screenX: 78,
		screenY: 0,
		width: 80,
		height,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

describe("DiffView", () => {
	test("Wide unified patch: one-space separator, right-aligned numbers, single column", () => {
		const diff = view({ kind: "unifiedPatch", text: PATCH });

		expect(diff.render(80)).toEqual([
			" 12 const a = 1;",
			'-13 const oldVal = "foo";',
			'+13 const newVal = "bar";',
			"+14 const extra = true;",
		]);
		expect(diffStats({ kind: "unifiedPatch", text: PATCH })).toEqual({ added: 2, removed: 1 });
	});

	test("Multiple hunks separate with a dim omission row and share one number column", () => {
		const text = [
			"--- a/f.ts",
			"+++ b/f.ts",
			"@@ -1,2 +1,2 @@",
			"-a",
			"+b",
			" c",
			"@@ -120,1 +120,1 @@",
			"-d",
			"+e",
		].join("\n");
		const rows = view({ kind: "unifiedPatch", text }).render(40);

		expect(rows).toEqual(["-  1 a", "+  1 b", "   2 c", "   …", "-120 d", "+120 e"]);
	});

	test("Structured hunks render without a patch parser and keep the same layout", () => {
		const diff = view({
			kind: "hunks",
			hunks: [
				{
					lines: [
						{ kind: "ctx", line: 1, text: "keep" },
						{ kind: "del", line: 2, text: "old" },
						{ kind: "add", line: 2, text: "new" },
					],
				},
			],
		});

		expect(diff.render(40)).toEqual(["  1 keep", "- 2 old", "+ 2 new"]);
		expect(diffStats({ kind: "hunks", hunks: [{ lines: [] }] })).toBeUndefined();
	});

	test("Narrow width with Chinese text: wide chars wrap instead of overflowing, continuations repeat nothing", () => {
		const long = "中文宽度测试".repeat(6);
		const diff = view({
			kind: "hunks",
			hunks: [{ lines: [{ kind: "add", line: 7, text: long }] }],
		});

		for (const width of [10, 14, 21, 80]) {
			const rows = diff.render(width);
			for (const row of rows) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
			expect(rows[0]?.startsWith("+ 7 ")).toBe(true);
			for (const row of rows.slice(1)) {
				expect(row.startsWith("    ")).toBe(true);
				expect(row).not.toContain("+");
			}
			expect(rows.join("")).not.toContain("│");
		}
		expect(diff.render(10).join("").replace(/[\s│]/g, "")).toBe(`+7${long}`);
	});

	test("Unparseable patch falls back to the raw text behind a short diagnostic", () => {
		const diff = view({ kind: "unifiedPatch", text: "this is not a patch" });

		expect(diff.render(80)).toEqual([
			"! unexpected line before the first hunk: this is not a patch",
			"this is not a patch",
		]);
		expect(diffStats({ kind: "unifiedPatch", text: "this is not a patch" })).toBeUndefined();

		const empty = view({ kind: "unifiedPatch", text: "   " });
		expect(empty.render(80)[0]).toBe("! empty patch");
	});
});

describe("edit rendering through ToolView", () => {
	const editDetails = {
		patch: PATCH,
		diff: [
			" 12 const a = 1;",
			'-13 const oldVal = "foo";',
			'+13 const newVal = "bar";',
			"+14 const extra = true;",
		].join("\n"),
		firstChangedLine: 13,
	};

	test("Success: header hides the top glyph, body is the DiffView, copy is the real patch", () => {
		const copied: string[] = [];
		const resolve = setupResolver(async (text) => {
			copied.push(text);
		});
		const renderers = resolve("edit", () => undefined) as ToolRenderers;
		const ctx = createMockContext();
		const result = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/index.ts." }],
				details: editDetails,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		const collapsed = result.render(80);
		expect(collapsed.length).toBe(1);
		expect(collapsed[0]).toContain("▸ edit src/index.ts (+2 -1)");

		clickHeader(result);
		const expanded = result.render(80);
		expect(expanded[0]).toContain("▾ edit src/index.ts (+2 -1)");
		expect(expanded.slice(1)).toEqual([
			"▎  12 const a = 1;",
			'▎ -13 const oldVal = "foo";',
			'▎ +13 const newVal = "bar";',
			"▎ +14 const extra = true;",
		]);

		clickCopy(result);
		expect(copied).toEqual([PATCH]);
	});

	test("Error: failure glyph plus the error text, never a diff", () => {
		const resolve = setupResolver();
		const renderers = resolve("edit", () => undefined) as ToolRenderers;
		const ctx = createMockContext({ isError: true });
		const result = renderers.renderResult!(
			{
				content: [{ type: "text", text: "oldText not found" }],
				details: editDetails,
				isError: true,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		const collapsed = result.render(80);
		expect(collapsed.length).toBe(1);
		expect(collapsed[0]).toContain("▸ ✗ edit src/index.ts");
		clickHeader(result);
		expect(result.render(80).slice(1)).toEqual(["▎ oldText not found"]);
	});

	test("Edit details without a usable diff fall back to the result text", () => {
		const resolve = setupResolver();
		const renderers = resolve("edit", () => undefined) as ToolRenderers;
		const ctx = createMockContext({ args: { path: "src/index.ts" } });
		const result = renderers.renderResult!(
			{ content: [{ type: "text", text: "No changes made to src/index.ts." }], details: {} },
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		expect(result.render(80)[0]).toContain("▸ ✓ edit src/index.ts");
		clickHeader(result);
		expect(result.render(80).slice(1)).toEqual(["▎ No changes made to src/index.ts."]);
	});

	test("Nested codemode summary is one compact line: edit <path> (+N -M) plus status", () => {
		const resolve = setupResolver();
		const renderers = resolve("codemode", () => undefined) as ToolRenderers;
		const ctx = createMockContext({ args: { code: "text(1);" } });
		const result = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Script completed\nWall time 0.2 seconds\nOutput:\nok" }],
				details: {
					calls: [
						{
							id: "1",
							name: "edit",
							args: '{"path":"src/index.ts"}',
							status: "ok",
							durationMs: 12,
						},
						{
							id: "2",
							name: "edit",
							args: '{"path":"src/other.ts"}',
							status: "error",
							error: "no match",
						},
						{ id: "3", name: "grep", args: '{"pattern":"x"}', status: "ok" },
					],
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		) as ToolView;

		const rows = result.render(80);
		expect(rows[0]).toContain("▸ codemode 2 ok · 1 failed · 200ms");
		expect(rows.slice(1)).toEqual([
			"▎ ✓ edit src/index.ts 12ms",
			"▎ ✗ edit src/other.ts",
			'▎ ✓ grep {"pattern":"x"}',
		]);
	});

	test("pi-ext-tools edit view renders old/new fragments with file line numbers", () => {
		const copied: string[] = [];
		const resolve = setupResolver(async (text) => {
			copied.push(text);
		});
		const renderers = resolve("edit", () => undefined) as ToolRenderers;
		const result = renderers.renderResult!(
			{
				content: [{ type: "text", text: "edited" }],
				details: {
					__piExtToolsEdit: { replacements: 2, added: 2, removed: 2 },
					__piExtToolsEditView: {
						kind: "multi",
						ops: [
							{
								oldContent: 'const a = 1;\nconst oldVal = "foo";',
								newContent: 'const a = 1;\nconst newVal = "bar";',
								language: "ts",
								editLine: 13,
								startLine: 12,
							},
							{
								oldContent: "return false;",
								newContent: "return true;\nreturn extra;",
								language: "ts",
								editLine: 40,
								startLine: 40,
							},
						],
					},
				},
			},
			{ expanded: true, isPartial: false },
			plainTheme,
			createMockContext(),
		) as ToolView;

		expect(result.render(80)[0]).toContain("▸ edit src/index.ts (+3 -2)");
		clickHeader(result);
		const rows = result.render(80);
		expect(rows[0]).toContain("▾ edit src/index.ts (+3 -2)");
		expect(rows.slice(1)).toEqual([
			"▎  12 const a = 1;",
			'▎ -13 const oldVal = "foo";',
			'▎ +13 const newVal = "bar";',
			"▎   …",
			"▎ -40 return false;",
			"▎ +40 return true;",
			"▎ +41 return extra;",
		]);

		clickCopy(result, 8);
		expect(copied).toEqual([
			[
				"@@ -12,2 +12,2 @@",
				" const a = 1;",
				'-const oldVal = "foo";',
				'+const newVal = "bar";',
				"@@ -40,1 +40,2 @@",
				"-return false;",
				"+return true;",
				"+return extra;",
			].join("\n"),
		]);
	});

	test("write uses its stored diff, new content, or no-change fact without reading files", () => {
		const copied: string[] = [];
		const resolve = setupResolver(async (text) => {
			copied.push(text);
		});
		const renderers = resolve("write", () => undefined) as ToolRenderers;
		const changed = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Successfully wrote 9 bytes to src/index.ts" }],
				details: {
					__piExtToolsWriteView: {
						kind: "diff",
						added: 1,
						removed: 1,
						lines: [
							{ type: "ctx", oldNum: 1, newNum: 1, content: "a" },
							{ type: "del", oldNum: 2, newNum: null, content: "old" },
							{ type: "add", oldNum: null, newNum: 2, content: "new" },
						],
					},
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({ args: { path: "src/index.ts", content: "a\nnew\n" } }),
		) as ToolView;
		expect(changed.render(80)[0]).toContain("▸ write src/index.ts (+1 -1)");
		clickHeader(changed);
		expect(changed.render(80).slice(1)).toEqual(["▎   1 a", "▎ - 2 old", "▎ + 2 new"]);

		const created = renderers.renderResult!(
			{
				content: [{ type: "text", text: "Successfully wrote 4 bytes to src/new.ts" }],
				details: { __piExtToolsWriteView: { kind: "new", lines: 1, content: "next" } },
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({ args: { path: "src/new.ts" } }),
		) as ToolView;
		expect(created.render(80)[0]).toContain("▸ ✓ write src/new.ts (new file (1 lines))");
		clickHeader(created);
		expect(created.render(80).slice(1)).toEqual(["▎ next"]);
		clickCopy(created);
		expect(copied).toEqual(["next"]);

		const unchanged = renderers.renderResult!(
			{
				content: [{ type: "text", text: "No changes made to src/index.ts." }],
				details: { __piExtToolsWriteView: { kind: "noChange" } },
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			createMockContext({ args: { path: "src/index.ts" } }),
		) as ToolView;
		expect(unchanged.render(80)[0]).toContain("▸ write src/index.ts (no changes)");
	});
});
