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

test("upstream-style panel keeps exact width at supported terminal sizes", (): void => {
	for (const width of [48, 100]) {
		const lines = renderMctxStatusLines(status, width, plainTheme);
		expect(lines).toHaveLength(17);
		for (const line of lines) expect(visibleWidth(line)).toBe(width);
	}
});

test("content follows upstream status dialog order", (): void => {
	const lines = renderMctxStatusLines(status, 100, plainTheme);
	expect(lines.slice(1, -1).map((_row, index) => contentRow(lines, index + 1))).toEqual([
		"⚡ Magic Context Status",
		"",
		"Context  30.0% · 1.2K / 4K tokens",
		"█".repeat(96),
		"",
		"Counts: 3 compartments",
		"Historian: running",
		"",
		"Tags",
		"Active 3 · Pending 1 · Dropped 1 · Total 5",
		"",
		"Context",
		"Execute threshold 65%",
		"Protected tags 20",
		"Press Escape to close",
	]);
	const rendered = lines.join("\n");
	expect(rendered).not.toContain("Partition");
	expect(rendered).not.toContain("Project");
	expect(rendered).not.toContain("Session");
	expect(rendered).not.toContain("sidekick");
});

test("usage bar uses upstream semantic threshold colors", (): void => {
	const roles: string[] = [];
	const semanticTheme: MctxStatusTheme = {
		fg: (role, text): string => {
			if (text.includes("█")) roles.push(role);
			return text;
		},
		bold: (text: string): string => text,
	};
	for (const [percentage, role] of [
		[30, "accent"],
		[65, "warning"],
		[80, "error"],
	] as const) {
		const lines = renderMctxStatusLines(withUsage(percentage), 48, semanticTheme);
		expect(contentRow(lines, 4)).toBe("█".repeat(44));
		expect(roles.at(-1)).toBe(role);
	}
});

test("unavailable usage does not invent token metrics or a bar", (): void => {
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
	expect(contentRow(lines, 3)).toBe("Context  ? · ? / ? tokens");
	expect(contentRow(lines, 4)).toBe("");
	expect(lines.join("\n")).not.toContain("0%");
});

test("diagnostics stay one safe line and states use the compact panel", (): void => {
	const failed: MctxStatusResult = {
		kind: "failed",
		reason: "database failed\nnext row\u001b[31mred\u001b[0m",
	};
	const lines = renderMctxStatusLines(failed, 48, plainTheme);
	expect(lines).toHaveLength(6);
	expect(lines.some((line) => line.includes("\n"))).toBeFalse();
	expect(lines.join("\n")).not.toContain("[31m");
	expect(contentRow(lines, 3)).toBe("Status: database failed next rowred");
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
		expect(frame).toHaveLength(17);
		expect(frame[1]).toContain("Magic Context Status");
		expect(frame.at(-1)).toContain("╰");
	}
});
