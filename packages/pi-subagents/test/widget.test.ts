import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	createChildIdentityWidget,
	createSubagentWidget,
	formatElapsed,
	isWidgetVisibleChild,
	renderChildIdentityWidget,
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
		expect(isWidgetVisibleChild(child({ state: "stopped" }), longAgo)).toBe(false);
		expect(isWidgetVisibleChild(child({ state: "failed" }), longAgo)).toBe(false);
		expect(isWidgetVisibleChild(child({ state: "failed", mode: "tui" }), longAgo)).toBe(false);

		// Inside the 15-second retain window: visible so user can see final outcome
		const recent = Date.parse("2026-01-01T00:00:10.000Z");
		expect(isWidgetVisibleChild(child({ state: "done" }), recent)).toBe(true);
		expect(isWidgetVisibleChild(child({ state: "stopped" }), recent)).toBe(true);
		expect(isWidgetVisibleChild(child({ state: "failed" }), recent)).toBe(true);

		// Non-terminal states: always visible
		expect(isWidgetVisibleChild(child({ state: "idle" }), longAgo)).toBe(true);
		expect(isWidgetVisibleChild(child({ state: "starting" }), longAgo)).toBe(true);
		expect(isWidgetVisibleChild(child({ state: "running", mode: "tui" }), longAgo)).toBe(true);
		expect(formatElapsed("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:05:00.000Z"))).toBe(
			"5m 0s",
		);
	});

	test("renders identity and state without a border on narrow and wide widths", () => {
		const children = [
			child({ id: "sa_running00000", agent: "worker", state: "running" }),
			child({ id: "sa_idle00000000", agent: "reviewer", state: "idle" }),
		];
		for (const width of [24, 40, 80, 120]) {
			const lines = renderSubagentWidget(children, width, identityTheme);
			expect(lines[0]).toContain("Subagents (2)");
			expect(lines.some((line) => line.includes("worker"))).toBe(true);
			expect(lines.some((line) => line.includes("reviewer"))).toBe(true);
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
		expect(running[0]).toContain("<warning>󰪠</warning>");
		expect(running[0]).toContain("<text>Subagents (1)</text>");
		expect(running[1]).toContain("<text>worker</text>");
		expect(running[1]).toContain("<accent>#sa_aaaaaaaaaaaa</accent>");
		expect(running[1]).toContain("<warning>running</warning>");
		expect(running[1]).toContain("<dim>· 12s</dim>");

		const interrupted = renderSubagentWidget(
			[child({ state: "idle", interrupted: "waiting for confirm" })],
			200,
			recordingTheme(),
			now,
		);
		expect(interrupted[1]).toContain("<warning>idle</warning>");
		expect(
			renderSubagentWidget(
				[child({ displayName: "Reviewer", freshness: "last_known", state: "idle" })],
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
		widget.refresh([child({ state: "idle" })]);
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
		expect(lines[1]).toContain("· 5m 12s");
		expect(lines[1]).toContain("Found the leak in auth.ts");
	});

	test("renders a borderless child identity line", () => {
		for (const width of [24, 40, 80]) {
			const lines = renderChildIdentityWidget(
				{ agent: "worker", toolCount: 3 },
				width,
				identityTheme,
			);
			expect(lines[0]).toContain("[worker]");
			expect(lines.some((line) => /[╭╮╰╯┌┐]/.test(line))).toBe(false);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		expect(
			renderChildIdentityWidget({ agent: "worker", toolCount: 3 }, 80, identityTheme)[0],
		).toContain("contact_parent");
		expect(
			createChildIdentityWidget(
				{ events: {} } as unknown as ExtensionAPI,
				{ mode: "rpc", ui: { setWidget: () => undefined } } as unknown as ExtensionContext,
				new AbortController().signal,
				{ agent: "worker", toolCount: 1 },
			),
		).toBeUndefined();
	});
});
