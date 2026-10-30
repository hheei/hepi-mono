import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type Member, TailUnit, ToolGroupView } from "../src/tool-group-view.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function ui(): ExtensionUIContext {
	return { theme, getToolsExpanded: () => false } as unknown as ExtensionUIContext;
}

function settledMember(): Member {
	return {
		kind: "tool",
		component: { render: () => ["row"], invalidate() {} },
		status: "ok",
		completed: true,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

/**
 * A settled block holds its surface color for five seconds. The block owns that timer, so a block the
 * projection drops must not keep the redraw it scheduled.
 */
describe("ToolGroupView lifetime", () => {
	/**
	 * The host keeps the transcript's bottom in view, so a tail whose own rows fall back drags the
	 * block above it down. A live tail reserves the tallest frame it showed and grows downward.
	 */
	test("a live tail keeps its height and pads below, never above", () => {
		let rows = ["head", "one"];
		const live: Member = {
			kind: "tool",
			component: {
				render: () => rows,
				invalidate() {},
			},
			status: "running",
			completed: false,
		};
		const tail = new TailUnit(live);
		expect(tail.render(20)).toEqual(["", "head", "one"]);
		rows = ["head", "one", "two"];
		tail.update(live);
		expect(tail.render(20)).toEqual(["", "head", "one", "two"]);
		rows = ["head"];
		tail.update(live);
		expect(tail.render(20)).toEqual(["", "head", "", ""]);
	});

	test("a settled tail drops the reservation so the folded row is its real height", () => {
		const rows = ["head", "one", "two"];
		const tail = new TailUnit({
			kind: "tool",
			component: { render: () => rows, invalidate() {} },
			status: "running",
			completed: false,
		});
		expect(tail.render(20)).toHaveLength(4);
		tail.update({
			kind: "tool",
			component: { render: () => ["head"], invalidate() {} },
			status: "ok",
			completed: true,
		});
		expect(tail.render(20)).toEqual(["", "head"]);
	});

	test("a settled block asks for one repaint when the hold expires", () => {
		vi.useFakeTimers();
		const redraw = vi.fn();
		const group = new ToolGroupView(ui(), redraw);
		group.update([settledMember()], undefined, [], undefined);
		group.render(40);
		vi.advanceTimersByTime(5_000);
		expect(redraw).toHaveBeenCalledTimes(1);
	});

	test("dispose cancels the pending hold, and is idempotent", () => {
		vi.useFakeTimers();
		const redraw = vi.fn();
		const group = new ToolGroupView(ui(), redraw);
		group.update([settledMember()], undefined, [], undefined);
		group.render(40);
		group.dispose();
		group.dispose();
		vi.advanceTimersByTime(5_000);
		expect(redraw).not.toHaveBeenCalled();
	});
});
