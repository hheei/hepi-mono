import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { replayTui, viewFrame } from "../../hepi-debug/src/tui-replay.js";
import type { MctxStatusResult } from "../src/feature.js";
import {
	createMctxStatusComponent,
	type MctxStatusTheme,
	renderMctxStatusLines,
} from "../src/status-surface.js";

const status: MctxStatusResult = {
	kind: "active",
	projectIdentity: "git:project",
	sessionId: "session-1",
	partitionRevision: 4,
	usage: { tokens: 1200, contextWindow: 4000, percentage: 30 },
	compartments: { total: 3, m0: 2, m1: 1, latestSequence: 8, latestPublishedRevision: 4 },
	tags: { total: 5, active: 3, pending: 1, dropped: 1 },
	historian: { phase: "running", model: "openai/gpt-5" },
	trigger: { percentage: 65, tokens: 2600, protectedTags: 20 },
	pendingAugmentation: true,
};

const plainTheme: MctxStatusTheme = {
	fg: (_role, text): string => text,
	bold: (text: string): string => text,
};

test("status lines fit exact 48 and 100 cell widths", (): void => {
	for (const width of [48, 100]) {
		const lines = renderMctxStatusLines(status, width, plainTheme);
		expect(lines.length).toBeGreaterThan(4);
		for (const line of lines) expect(visibleWidth(line)).toBe(width);
	}
});

test("status component replays at the agreed narrow and wide terminal sizes", async (): Promise<void> => {
	for (const { columns, rows } of [
		{ columns: 48, rows: 20 },
		{ columns: 100, rows: 24 },
	]) {
		const replay = await replayTui({
			columns,
			rows,
			create: (host) =>
				createMctxStatusComponent({
					feature: { status: () => status },
					context: { ui: { theme: plainTheme } } as ExtensionContext,
					host: {
						theme: plainTheme,
						requestRender: () => host.requestRender(),
						close: () => undefined,
					},
					startTimer: () => () => undefined,
				}),
		});
		const frame = viewFrame(replay.last);
		expect(frame[0]).toContain("MCTX STATUS");
		expect(frame.some((line) => line.includes("Runtime") && line.includes("active"))).toBeTrue();
		expect(frame.some((line) => line.includes("╰"))).toBeTrue();
	}
});

test("status lines hide identity in narrow layout and show it wide", (): void => {
	expect(renderMctxStatusLines(status, 48, plainTheme).join("\n")).not.toContain("git:project");
	expect(renderMctxStatusLines(status, 100, plainTheme).join("\n")).toContain("git:project");
});

test("inactive and failed states render semantic reason", (): void => {
	const roles: string[] = [];
	const semanticTheme: MctxStatusTheme = {
		fg: (role, text): string => {
			roles.push(role);
			return text;
		},
		bold: (text: string): string => text,
	};
	const inactive: MctxStatusResult = {
		kind: "inactive",
		reason: "unavailable",
		diagnostic: "model unavailable",
	};
	const failed: MctxStatusResult = { kind: "failed", reason: "store read failed" };
	expect(renderMctxStatusLines(status, 48, semanticTheme).join("\n")).toContain("Runtime active");
	expect(renderMctxStatusLines(inactive, 48, semanticTheme).join("\n")).toContain(
		"model unavailable",
	);
	expect(renderMctxStatusLines(failed, 48, semanticTheme).join("\n")).toContain(
		"store read failed",
	);
	expect(roles).toContain("success");
	expect(roles).toContain("warning");
	expect(roles).toContain("error");
});
