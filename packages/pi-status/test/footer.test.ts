import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
	CompactFooterComponent,
	type FooterTheme,
	formatCompactWindow,
	formatCwdForFooter,
	formatFooterContext,
	formatFooterModel,
	layoutTwoColumnRow,
	type ReadonlyFooterDataProvider,
} from "../src/index.js";

const mockTheme = {
	fg(
		color: "dim" | "muted" | "success" | "warning" | "error" | "accent" | "text",
		text: string,
	): string {
		return `[${color}:${text}]`;
	},
};

describe("compact footer formatting", () => {
	test("formats cwd with tilde for home directory", () => {
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/var/log", "/home/user")).toBe("/var/log");
		expect(formatCwdForFooter("/some/path", undefined)).toBe("/some/path");
	});

	test("formats compact context window numbers", () => {
		expect(formatCompactWindow(0)).toBe("0");
		expect(formatCompactWindow(100_000)).toBe("100K");
		expect(formatCompactWindow(128_000)).toBe("128K");
		expect(formatCompactWindow(200_000)).toBe("200K");
		expect(formatCompactWindow(1_000_000)).toBe("1M");
		expect(formatCompactWindow(2_000_000)).toBe("2M");
	});

	test("formats footer model with provider and thinking level", () => {
		expect(formatFooterModel({ id: "gemini-3.8-flash", provider: "gm" }, "high")).toBe(
			"gm/gemini-3.8-flash(high)",
		);

		// "off" thinking level is omitted for compactness
		expect(formatFooterModel({ id: "gemini-3.8-flash", provider: "gm" }, "off")).toBe(
			"gm/gemini-3.8-flash",
		);

		// undefined thinking level is omitted
		expect(formatFooterModel({ id: "gemini-3.8-flash", provider: "gm" }, undefined)).toBe(
			"gm/gemini-3.8-flash",
		);

		// without provider
		expect(formatFooterModel({ id: "claude-3.7-sonnet" }, "medium")).toBe(
			"claude-3.7-sonnet(medium)",
		);

		// without model
		expect(formatFooterModel(undefined, undefined)).toBe("no-model");
	});

	test("formats context ratio with semantic color thresholds", () => {
		// <= 70% is dim
		expect(
			formatFooterContext({ percent: 12, contextWindow: 1_000_000 }, 1_000_000, mockTheme),
		).toBe("[dim:12%/1M]");

		// 70% ~ 90% is warning
		expect(formatFooterContext({ percent: 75.4, contextWindow: 200_000 }, 200_000, mockTheme)).toBe(
			"[warning:75%/200K]",
		);

		// > 90% is error
		expect(formatFooterContext({ percent: 94.8, contextWindow: 100_000 }, 100_000, mockTheme)).toBe(
			"[error:95%/100K]",
		);

		// missing percent shows ?%
		expect(formatFooterContext(undefined, 128_000, mockTheme)).toBe("[dim:?%/128K]");
	});

	test("arranges two columns with left-priority truncation on narrow widths", () => {
		const left = "gm/gemini-3.8-flash(high) · 12%/1M";
		const right = "󰪠 #1 Task title";

		// 1. Ample space: left on left, right on right
		const wide = layoutTwoColumnRow(left, right, 80);
		expect(wide).toContain(left);
		expect(wide).toContain(right);
		expect(wide.endsWith(right)).toBe(true);

		// 2. Constrained space: right is truncated with ellipsis, left is preserved intact
		// left is 34 cols, minGap is 2, available for right is 44 - 36 = 8 cols
		const medium = layoutTwoColumnRow(left, right, 44);
		expect(medium.startsWith(left)).toBe(true);
		expect(medium).toContain("…");

		// 3. Narrow space: right is dropped entirely to keep left complete
		// available for right would be 37 - 34 - 2 = 1 col (< 4 cols), so dropped
		const narrow = layoutTwoColumnRow(left, right, 37);
		expect(narrow).toBe(left);

		// 4. Extremely narrow: left is truncated to fit width
		const extreme = layoutTwoColumnRow(left, right, 20);
		expect(visibleWidth(extreme)).toBe(20);
	});
});

describe("CompactFooterComponent", () => {
	test("renders two distinct lines with correct data integration", () => {
		const extensionStatuses = new Map<string, string>([["pi-ext-tools:todo", "󰪠 #1 Task title"]]);
		const footerData: ReadonlyFooterDataProvider = {
			getGitBranch: () => "main",
			getExtensionStatuses: () => extensionStatuses,
			onBranchChange: vi.fn(() => () => {}),
			getAvailableProviderCount: () => 1,
		};

		const ctx = {
			model: { id: "gemini-3.8-flash", provider: "gm", contextWindow: 1_000_000 },
			thinkingLevel: "high",
			getContextUsage: () => ({ percent: 12.3, contextWindow: 1_000_000, tokens: 123_000 }),
			sessionManager: {
				getCwd: () => "/home/user/hepi-mono",
				getSessionName: () => "Optimize footer",
			},
		} as unknown as ExtensionContext;

		const tui = { requestRender: vi.fn() };
		const footer = new CompactFooterComponent(
			ctx,
			tui,
			mockTheme as unknown as FooterTheme,
			footerData,
		);

		const lines = footer.render(80);
		expect(lines).toHaveLength(2);

		// Line 1: cwd + branch on left, session name on right
		expect(lines[0]).toContain("hepi-mono (main)");
		expect(lines[0]).toContain("Optimize footer");

		// Line 2: provider/model(level) · context on left, todo on right
		expect(lines[1]).toContain("gm/gemini-3.8-flash(high)");
		expect(lines[1]).toContain("·");
		expect(lines[1]).toContain("12%/1M");
		expect(lines[1]).toContain("󰪠 #1 Task title");

		footer.dispose();
	});
});
