import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { createMessageView } from "../src/message-view.js";

const theme = {
	fg: (token: string, text: string) => `[${token}]${text}[/]`,
} as unknown as Theme;

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
		expect(message.render(80)).toEqual([
			"[dim]▸[/] [dim]memory[/][dim] · [/][dim]2 pages[/]",
			"  alpha",
		]);
		expect(message.handleMouse(click(1))).toBeUndefined();
		expect(invalidate).not.toHaveBeenCalled();
		expect(message.handleMouse(click(0))).toEqual({ handled: true, render: true });
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(message.render(80)[2]).toBe("  snippet");
		expect(message.render(80)[0]).toContain("▾");
	});

	test("remembers expansion on the holder, not on the component", () => {
		const holder = {};
		const first = view({ stateHolder: holder });
		first.toggle();
		const second = view({ stateHolder: holder });
		expect(second.expanded).toBe(true);
		expect(second.render(80)).toHaveLength(3);
	});

	test("draws no pin and ignores clicks when there is nothing to open", () => {
		const message = view({
			body: undefined,
			preview: undefined,
			header: { kind: "idle", summary: "2m" },
		});
		expect(message.expandable).toBe(false);
		expect(message.render(40)[0]).toBe("[dim]idle[/][dim] · [/][dim]2m[/]");
		expect(message.handleMouse(click(0))).toBeUndefined();
	});

	test("ctrl+o forces the body open and a click there is a collapse for later", () => {
		const holder = {};
		const forced = view({ stateHolder: holder, forcedExpanded: true });
		expect(forced.render(80)).toHaveLength(3);
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
		expect(message.render(80)).toEqual([
			"  [dim]▾[/] [dim]agents[/][dim] · [/][error]failed[/]",
			"    one",
			"    two",
		]);
	});

	test("wraps long preview and body lines across multiple rows", () => {
		const longLine = "very long line ".repeat(10).trim();
		const message = view({
			preview: [longLine],
			body: [longLine],
		});
		message.toggle();
		const rows = message.render(40);
		expect(rows.length).toBeGreaterThan(6);
		for (const row of rows.slice(1)) {
			expect(row.startsWith("  ")).toBe(true);
		}
	});
});
