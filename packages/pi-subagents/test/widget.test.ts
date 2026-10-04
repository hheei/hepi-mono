import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
	createSubagentWidget,
	formatElapsed,
	isWidgetVisibleChild,
	renderSubagentWidget,
} from "../src/widget.js";
import { child } from "./helpers/records.js";

const identityTheme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

function recordingTheme() {
	return {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	} as unknown as Theme;
}

describe("subagent widget projection", () => {
	test("hides terminal states after window and keeps live plus TUI children", () => {
		// Outside the 15-second retain window: hidden
		const longAgo = Date.parse("2026-01-01T00:01:00.000Z");
		expect(isWidgetVisibleChild(child({ state: "done" }), longAgo)).toBe(false);
		expect(isWidgetVisibleChild(child({ state: "blocked" }), longAgo)).toBe(false);
		expect(isWidgetVisibleChild(child({ state: "error" }), longAgo)).toBe(false);
		expect(isWidgetVisibleChild(child({ state: "error", presentation: "panel" }), longAgo)).toBe(
			false,
		);

		// Inside the 15-second retain window: visible so user can see final outcome
		const recent = Date.parse("2026-01-01T00:00:10.000Z");
		expect(isWidgetVisibleChild(child({ state: "done" }), recent)).toBe(true);
		expect(isWidgetVisibleChild(child({ state: "blocked" }), recent)).toBe(true);
		expect(isWidgetVisibleChild(child({ state: "error" }), recent)).toBe(true);

		// Running state: always visible
		expect(isWidgetVisibleChild(child({ state: "running" }), longAgo)).toBe(true);
		expect(isWidgetVisibleChild(child({ state: "running", presentation: "panel" }), longAgo)).toBe(
			true,
		);
		expect(formatElapsed("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:05:00.000Z"))).toBe(
			"5m 0s",
		);
	});

	test("renders identity and state without a border on narrow and wide widths", () => {
		const children = [
			child({ id: "sa_running00000", agent: "worker", state: "running" }),
			child({ id: "sa_idle00000000", agent: "reviewer", state: "running" }),
		];
		for (const width of [24, 40, 80, 120]) {
			const lines = renderSubagentWidget(children, width, identityTheme);
			expect(lines[0]).toContain("Agents:");
			if (width >= 40) {
				expect(lines.some((line) => line.includes("worker"))).toBe(true);
				expect(lines.some((line) => line.includes("reviewer"))).toBe(true);
			} else {
				expect(lines.some((line) => line.includes("work"))).toBe(true);
			}
			expect(lines.some((line) => /[╭╮╰╯┌┐]/.test(line))).toBe(false);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		const wide = renderSubagentWidget(children, 120, identityTheme);
		expect(wide.some((line) => line.includes("sa_running00000"))).toBe(true);
		expect(wide.some((line) => line.includes("sa_idle00000000"))).toBe(true);
	});

	test("uses theme tokens instead of hardcoded colors", () => {
		const now = Date.parse("2026-01-01T00:00:12.000Z");
		const running = renderSubagentWidget([child()], 200, recordingTheme(), now);
		expect(running[0]).toContain("🤖");
		expect(running[0]).toContain("<text>Agents:</text>");
		expect(running[1]).toContain("<accent>󰪠</accent>");
		expect(running[1]).toContain("<dim>#sa_aaaaaaaaaaaa</dim>");
		expect(running[1]).toContain("<text>worker</text>");
		expect(running[1]).toContain("<dim>12s</dim>");
		expect(running[1]).toContain("<accent>running</accent>");
		expect(running[1]).toContain("<dim>0 turns</dim>");

		const interrupted = renderSubagentWidget(
			[child({ state: "blocked", interrupted: "waiting for confirm" })],
			200,
			recordingTheme(),
			now,
		);
		expect(interrupted[1]).toContain("<warning>blocked</warning>");
		expect(
			renderSubagentWidget(
				[child({ displayName: "Reviewer", freshness: "last_known", state: "done" })],
				200,
				recordingTheme(),
				now,
			)[1],
		).toContain("<text>Reviewer</text>");
	});

	test("is absent outside TUI and hides when no live children remain", () => {
		const calls: Array<{ key: string; content: unknown }> = [];
		const pi = { events: {} } as unknown as ExtensionAPI;
		const rpc = {
			mode: "rpc",
			ui: { setWidget: () => undefined },
		} as unknown as ExtensionContext;
		expect(createSubagentWidget(pi, rpc, new AbortController().signal, [child()])).toBeUndefined();

		const controller = new AbortController();
		const tui = {
			mode: "tui",
			ui: {
				setWidget: (key: string, content: unknown) => {
					calls.push({ key, content });
				},
			},
		} as unknown as ExtensionContext;
		const widget = createSubagentWidget(pi, tui, controller.signal, [child()]);
		if (widget === undefined) throw new Error("expected TUI widget");
		expect(calls[0]?.key).toBe("@hheei/pi-subagents:status");
		expect(typeof calls[0]?.content).toBe("function");
		widget.refresh([child({ state: "done" })]);
		expect(calls.at(-1)?.content).toBeUndefined();
		widget.refresh([child({ state: "running" })]);
		expect(typeof calls.at(-1)?.content).toBe("function");
		controller.abort();
		expect(calls.at(-1)?.content).toBeUndefined();
		widget.dispose();
	});

	test("ages elapsed from spawn time and shows a summary snippet", () => {
		const now = Date.parse("2026-01-01T00:05:12.000Z");
		const lines = renderSubagentWidget(
			[
				child({
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:05:10.000Z",
					summary: "Found the leak\nin auth.ts",
				}),
			],
			200,
			identityTheme,
			now,
		);
		expect(lines[1]).toContain("5m 12s");
		expect(lines[1]).toContain("Found the leak in auth.ts");
	});

	test("prioritizes activeTool over summary when tool is executing", () => {
		const now = Date.parse("2026-01-01T00:00:10.000Z");
		const lines = renderSubagentWidget(
			[
				child({
					createdAt: "2026-01-01T00:00:00.000Z",
					activeTool: "bash",
					summary: "previous turn summary",
				}),
			],
			200,
			identityTheme,
			now,
		);
		expect(lines[1]).toContain("bash");
		expect(lines[1]).not.toContain("previous turn summary");
	});

	test("freezes terminal elapsed and stops the timer when the error row expires", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
		const controller = new AbortController();
		try {
			const failed = child({ state: "error", updatedAt: new Date().toISOString() });
			for (const now of [Date.now(), Date.now() + 10_000]) {
				const row = renderSubagentWidget([failed], 200, identityTheme, now)[1];
				expect(row).toContain("10s");
				expect(row).toContain("error");
			}
			const setWidget = vi.fn();
			const widget = createSubagentWidget(
				{ events: {} } as unknown as ExtensionAPI,
				{ mode: "tui", ui: { setWidget } } as unknown as ExtensionContext,
				controller.signal,
				[child()],
			);
			if (widget === undefined) throw new Error("expected widget");
			widget.refresh([failed]);
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			vi.advanceTimersByTime(15_000);
			expect(setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
			widget.dispose();
		} finally {
			controller.abort();
			vi.useRealTimers();
		}
	});
});
