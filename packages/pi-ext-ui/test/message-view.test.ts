import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { createMessageView } from "../src/message-view.js";

const theme = {
	fg: (token: string, text: string) => `[${token}]${text}[/]`,
	bg: (_token: string, text: string) => text,
} as unknown as Theme;

test("a standalone message draws its own custom-message block background", () => {
	const tokens: string[] = [];
	const spy = {
		fg: (_token: string, text: string) => text,
		bg: (token: string, text: string) => {
			tokens.push(token);
			return text;
		},
	} as unknown as Theme;
	const view = createMessageView({ theme: spy, header: { kind: "memory", summary: "page" } });
	view.render(40);
	expect(tokens).toContain("customMessageBg");
});

test("a standalone message gives its surface one padding row above and below", () => {
	const spy = {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => `\x1b[48;5;236m${text}\x1b[49m`,
	} as unknown as Theme;
	const message = createMessageView({
		theme: spy,
		header: { kind: "memory", summary: "page" },
		preview: ["alpha"],
	});
	const rows = message.render(20);
	// A colored block that owns its rows also owns the breathing room around them.
	expect(rows[0]).toBe(`\x1b[48;5;236m${" ".repeat(20)}\x1b[49m`);
	expect(rows.at(-1)).toBe(`\x1b[48;5;236m${" ".repeat(20)}\x1b[49m`);
	expect(rows[1]).toContain("memory");
});

test("a cache hit returns the filled rows, not the pre-shell lines", () => {
	const spy = {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => `\x1b[48;5;236m${text}\x1b[49m`,
	} as unknown as Theme;
	const message = createMessageView({
		theme: spy,
		header: { kind: "memory", summary: "page" },
	});
	const first = message.render(20);
	const second = message.render(20);
	expect(second).toEqual(first);
	expect(second[0]).toContain("\x1b[48;5;236m");
});

/** The block background fills each row to the terminal width; trailing padding is not content. */
function rendered(view: ReturnType<typeof createMessageView>, width = 80): string[] {
	return view.render(width).map((row) => row.trimEnd());
}

function click(y: number, x = 0): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

function view(overrides: Partial<Parameters<typeof createMessageView>[0]> = {}) {
	return createMessageView({
		theme,
		header: { kind: "memory", summary: "2 pages" },
		preview: ["alpha"],
		body: ["snippet"],
		...overrides,
	});
}

describe("MessageView", () => {
	test("keeps the preview and hides the body until the header is clicked", () => {
		const invalidate = vi.fn();
		const message = view({ invalidate });
		expect(rendered(message)).toEqual([
			"",
			"[dim]▸[/] [dim]memory[/][dim] · [/][dim]2 pages[/]",
			"  alpha",
			"",
		]);
		// The surface's own padding rows are not the header: only row 1 toggles the body.
		expect(message.handleMouse(click(0))).toBeUndefined();
		expect(message.handleMouse(click(2))).toBeUndefined();
		expect(invalidate).not.toHaveBeenCalled();
		expect(message.handleMouse(click(1))).toEqual({ handled: true, render: true });
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(rendered(message)[3]).toBe("  snippet");
		expect(rendered(message)[1]).toContain("▾");
	});

	test("remembers expansion on the holder, not on the component", () => {
		const holder = {};
		const first = view({ stateHolder: holder });
		first.toggle();
		const second = view({ stateHolder: holder });
		expect(second.expanded).toBe(true);
		expect(second.render(80)).toHaveLength(5);
	});

	test("draws no pin and ignores clicks when there is nothing to open", () => {
		const message = view({
			body: undefined,
			preview: undefined,
			header: { kind: "idle", summary: "2m" },
		});
		expect(message.expandable).toBe(false);
		expect(rendered(message, 40)[1]).toBe("[dim]idle[/][dim] · [/][dim]2m[/]");
		expect(message.handleMouse(click(0))).toBeUndefined();
		expect(message.handleMouse(click(1))).toBeUndefined();
	});

	test("ctrl+o forces the body open and a click there is a collapse for later", () => {
		const holder = {};
		const forced = view({ stateHolder: holder, forcedExpanded: true });
		expect(forced.render(80)).toHaveLength(5);
		forced.toggle();
		expect(forced.expanded).toBe(true);
		const released = view({ stateHolder: holder });
		expect(released.expanded).toBe(false);
	});

	test("colors the summary and indents a multi-line body", () => {
		const message = view({
			header: { kind: "agents", summary: "failed", tone: "error" },
			preview: undefined,
			body: "one\ntwo",
			outputPad: 2,
		});
		message.toggle();
		expect(rendered(message)).toEqual([
			"",
			"  [dim]▾[/] [dim]agents[/][dim] · [/][error]failed[/]",
			"    one",
			"    two",
			"",
		]);
	});

	test("wraps long preview and body lines across multiple rows", () => {
		const longLine = "very long line ".repeat(10).trim();
		const message = view({
			preview: [longLine],
			body: [longLine],
		});
		message.toggle();
		const rows = rendered(message, 40);
		expect(rows.length).toBeGreaterThan(8);
		// Row 0 and the last row are the surface's padding; row 1 is the header.
		for (const row of rows.slice(2, -1)) {
			expect(row.startsWith("  ")).toBe(true);
		}
	});
});
