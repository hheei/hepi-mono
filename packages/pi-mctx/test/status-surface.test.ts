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

type ActiveStatus = Extract<MctxStatusResult, { readonly kind: "active" }>;

const status: ActiveStatus = {
	kind: "active",
	projectIdentity: "git:project",
	sessionId: "session-1",
	partitionRevision: 4,
	usage: { tokens: 1200, contextWindow: 4000, percentage: 30 },
	compartments: { total: 3, m0: 2, m1: 1, latestSequence: 8, latestPublishedRevision: 4 },
	tags: { total: 5, active: 3, pending: 1, dropped: 1 },
	historian: { kind: "active", phase: "running", model: "openai/gpt-5" },
	trigger: { percentage: 65, tokens: 2600, protectedTags: 20 },
};

const plainTheme: MctxStatusTheme = {
	fg: (_role, text): string => text,
	bold: (text: string): string => text,
};

function contentRow(lines: readonly string[], index: number): string {
	const line = lines[index];
	if (line === undefined) throw new Error(`Missing rendered status line ${index}`);
	return line.slice(2, -2).trimEnd();
}

function withUsage(percentage: number): ActiveStatus {
	return { ...status, usage: { tokens: 1200, contextWindow: 4000, percentage } };
}

test("status frame has exact 20 rows and exact cell width", (): void => {
	for (const width of [1, 2, 3, 7, 48, 100]) {
		const lines = renderMctxStatusLines(status, width, plainTheme);
		expect(lines).toHaveLength(20);
		for (const line of lines) expect(visibleWidth(line)).toBe(width);
	}
});

test("status text is forced onto one safe terminal line", (): void => {
	const unsafe: MctxStatusResult = {
		kind: "failed",
		reason: "database failed\nnext row\u001b[31mred\u001b[0m",
	};
	const lines = renderMctxStatusLines(unsafe, 48, plainTheme);
	expect(lines).toHaveLength(20);
	expect(lines.some((line) => line.includes("\n"))).toBeFalse();
	expect(lines.join("\n")).not.toContain("[31m");
	expect(lines.join("\n")).toContain("database failed next rowred");
});

test("top border is plain and title starts first content row", (): void => {
	const lines = renderMctxStatusLines(status, 48, plainTheme);
	expect(lines[0]).toBe(`╭${"─".repeat(46)}╮`);
	expect(lines[0]).not.toContain("Magic Context Status");
	expect(contentRow(lines, 1)).toContain("⚡ Magic Context Status");
	expect(contentRow(lines, 1)).toContain("Runtime active");
});

test("content rows retain legacy order and compact values", (): void => {
	const lines = renderMctxStatusLines(status, 100, plainTheme);
	const rows = lines.slice(1, 18).map((_row, index) => contentRow(lines, index + 1));
	expect(rows).toEqual([
		"⚡ Magic Context Status · Runtime active",
		"",
		"Context",
		"Context  30.0% · 1.2K / 4K tokens",
		"█".repeat(29) + "░".repeat(67),
		"",
		"Counts:",
		"Compartments  m0: 2 · m1: 1 · total: 3",
		"Tags",
		"Tags  active: 3 · pending: 1 · dropped: 1 · protected: 20",
		"",
		"Historian:",
		"Historian  running · openai/gpt-5",
		"Trigger  65% · 2.6K tokens",
		"Partition  revision: 4",
		"Project  git:project",
		"Session  session-1",
	]);
	expect(contentRow(lines, 18)).toBe("Press Escape to close · Enter / Ctrl+C also close");
});

test("usage bar uses full content width and semantic thresholds", (): void => {
	const roles: string[] = [];
	const semanticTheme: MctxStatusTheme = {
		fg: (role, text): string => {
			if (text.includes("█") || text.includes("░")) roles.push(role);
			return text;
		},
		bold: (text: string): string => text,
	};
	for (const [percentage, role] of [
		[30, "success"],
		[65, "warning"],
		[80, "error"],
	] as const) {
		const lines = renderMctxStatusLines(withUsage(percentage), 48, semanticTheme);
		const bar = contentRow(lines, 5);
		expect(bar).toMatch(/^[█░]{44}$/);
		expect(roles.at(-1)).toBe(role);
	}
});

test("missing usage reserves value and bar rows without inventing zero", (): void => {
	const missing: MctxStatusResult = {
		kind: "active",
		projectIdentity: status.projectIdentity,
		sessionId: status.sessionId,
		partitionRevision: status.partitionRevision,
		compartments: status.compartments,
		tags: status.tags,
		historian: status.historian,
		trigger: status.trigger,
	};
	const lines = renderMctxStatusLines(missing, 48, plainTheme);
	expect(contentRow(lines, 4)).toBe("Context  — · — / — tokens");
	expect(contentRow(lines, 5)).toBe("");
	expect(lines.join("\n")).not.toContain("0%");
});

test("wide identity is hidden narrowly and shown at wide width", (): void => {
	const narrow = renderMctxStatusLines(status, 48, plainTheme);
	const wide = renderMctxStatusLines(status, 100, plainTheme);
	expect(narrow.join("\n")).not.toContain("git:project");
	expect(narrow.join("\n")).not.toContain("session-1");
	expect(contentRow(wide, 16)).toBe("Project  git:project");
	expect(contentRow(wide, 17)).toBe("Session  session-1");
});

test("active, inactive, failed, and stale states keep same height", (): void => {
	const inactive: MctxStatusResult = {
		kind: "inactive",
		reason: "unavailable",
		diagnostic: "model unavailable",
	};
	const failed: MctxStatusResult = { kind: "failed", reason: "store read failed" };
	const snapshots: readonly MctxStatusResult[] = [status, inactive, failed, { kind: "stale" }];
	for (const snapshot of snapshots) {
		const lines = renderMctxStatusLines(snapshot, 48, plainTheme);
		expect(lines).toHaveLength(20);
		for (const line of lines) expect(visibleWidth(line)).toBe(48);
	}
	expect(contentRow(renderMctxStatusLines(inactive, 48, plainTheme), 4)).toContain(
		"model unavailable",
	);
	expect(contentRow(renderMctxStatusLines(failed, 48, plainTheme), 4)).toContain(
		"store read failed",
	);
});

test("status component replays at 48x20 and 100x24", async (): Promise<void> => {
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
		expect(frame).toHaveLength(20);
		expect(frame[0]).toContain("╭");
		expect(frame[1]).toContain("Magic Context Status");
		expect(frame[19]).toContain("╰");
	}
});
