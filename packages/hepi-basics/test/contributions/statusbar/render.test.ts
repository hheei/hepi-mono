import { describe, expect, test } from "bun:test";
import type { StatusbarSnapshot } from "../../../src/core/contributions/statusbar/model.js";
import {
	renderExtensionStatusFooter,
	renderStatusbarLine,
} from "../../../src/core/contributions/statusbar/render.js";
import { visibleWidth } from "../../../src/core/ui/text.js";

const theme = { fg: (_role: string, text: string) => text } as never;

function snapshot(overrides: Partial<StatusbarSnapshot> = {}): StatusbarSnapshot {
	return {
		model: "M",
		thinkingLevel: "off",
		meter: "⡀⠀",
		contextTokens: "?",
		contextLimit: "0",
		percent: 0,
		statuses: [],
		...overrides,
	};
}

const baseSnapshot = snapshot({
	model: "GPT-5.6",
	thinkingLevel: "medium",
	meter: "⣶⣶",
	contextTokens: "123.5k",
	contextLimit: "350k",
	percent: 70,
	sessionName: "Session title",
	statuses: ["active"],
});

describe("statusbar renderer", () => {
	test("keeps grammar, status order and right-aligned title", () => {
		const line = renderStatusbarLine(100, baseSnapshot, theme);
		expect(line).toContain("─ π · ◑ GPT-5.6 · ⣶⣶ 123.5k/350k · active");
		expect(line.endsWith("Session title ─")).toBe(true);
		expect(visibleWidth(line)).toBe(100);
		expect(line).not.toContain("\n");
	});

	test("renders Advisor health after the model and keeps it on narrow rows", () => {
		const calls: Array<{ role: string; text: string }> = [];
		const recordingTheme = {
			fg(role: string, text: string) {
				calls.push({ role, text });
				return text;
			},
		} as never;
		for (const [advisorIndicator, role] of [
			["ok", "accent"],
			["concern", "warning"],
			["blocker", "error"],
		] as const) {
			calls.length = 0;
			const current = snapshot({
				model: "GPT-5.6 Sol",
				thinkingLevel: "medium",
				meter: "⣀⣀",
				contextTokens: "82.2k",
				contextLimit: "372k",
				percent: 22,
				advisorIndicator,
			});
			expect(renderStatusbarLine(80, current, recordingTheme)).toContain(
				"◑ GPT-5.6 Sol ✦ · ⣀⣀ 82.2k/372k",
			);
			expect(calls.find((call) => call.text === "✦")?.role).toBe(role);
			expect(renderStatusbarLine(20, current, recordingTheme)).toContain("✦");
		}
		const longModel = snapshot({
			model: "A model name too long for the narrow rail",
			thinkingLevel: "medium",
			meter: "⣀⣀",
			contextTokens: "82.2k",
			contextLimit: "372k",
			percent: 22,
			advisorIndicator: "ok",
		});
		for (const width of [1, 2, 3, 8, 20]) {
			const line = renderStatusbarLine(width, longModel, recordingTheme);
			expect(line).toContain("✦");
			expect(visibleWidth(line)).toBe(width);
		}
	});

	test("degrades narrow rows to one cell-safe line", () => {
		for (const width of [1, 2, 3, 8, 20]) {
			const line = renderStatusbarLine(width, baseSnapshot, theme);
			expect(visibleWidth(line)).toBe(width);
			expect(line).not.toContain("\n");
		}
	});

	test("omits title when absent", () => {
		const { sessionName: _sessionName, ...withoutTitle } = baseSnapshot;
		const line = renderStatusbarLine(80, withoutTitle, theme);
		expect(line).not.toContain("Session title");
		expect(line.endsWith("─")).toBe(true);
	});

	test("renders compact extension statuses as one cell-safe footer row", () => {
		for (const width of [0, 1, 8, 40]) {
			const lines = renderExtensionStatusFooter(width, ["⠧", "⛁ 0/3", "PLAN"], theme);
			if (width === 0) {
				expect(lines).toEqual([]);
				continue;
			}
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0] ?? "")).toBe(width);
		}
		expect(renderExtensionStatusFooter(80, [], theme)).toEqual([]);
		expect(renderExtensionStatusFooter(80, ["⠧", "⛁ 0/3", "PLAN", "GOAL"], theme)[0]).toContain(
			"⠧ · ⛁ 0/3 · PLAN · GOAL",
		);
	});
});

test("maps every thinking level to muted glyph and records semantic roles", () => {
	const calls: Array<{ role: string; text: string }> = [];
	const recordingTheme = {
		fg(role: string, text: string) {
			calls.push({ role, text });
			return `\x1b[${calls.length}m${text}\x1b[0m`;
		},
	} as never;
	for (const [thinkingLevel, glyph] of [
		["off", "○"],
		["minimal", "○"],
		["low", "◔"],
		["medium", "◑"],
		["high", "◕"],
		["xhigh", "●"],
		["max", "●"],
	] as const) {
		calls.length = 0;
		renderStatusbarLine(
			120,
			snapshot({
				model: "M",
				thinkingLevel,
				meter: "⣤⣤",
				contextLimit: "10",
				percent: 50,
				sessionName: "T",
			}),
			recordingTheme,
		);
		expect(calls.find((call) => call.text === glyph)).toEqual({ role: "muted", text: glyph });
	}
	const roleOf = (text: string): string | undefined =>
		calls.find((call) => call.text === text)?.role;
	expect(roleOf("π")).toBe("accent");
	expect(roleOf("M")).toBe("text");
	expect(roleOf("T")).toBe("muted");
	expect(roleOf("·")).toBe("muted");
	expect(roleOf("◫")).toBeUndefined();
	expect(roleOf("─")).toBe("border");
});

test("uses independent theme roles for known and unknown usage", () => {
	const calls: Array<{ role: string; text: string }> = [];
	const recordingTheme = {
		fg: (role: string, text: string) => {
			calls.push({ role, text });
			return text;
		},
	} as never;
	const render = (
		percent: number | null,
		contextLimit: string,
		meter: string,
	): Map<string, string> => {
		calls.length = 0;
		renderStatusbarLine(
			120,
			snapshot({ model: "M", percent, meter, contextLimit }),
			recordingTheme,
		);
		return new Map(calls.map((call) => [call.text, call.role]));
	};
	expect(render(50, "10", "⣤⣤").get("⣤⣤")).toBe("success");
	expect(render(80, "10", "⣷⣶").get("⣷⣶")).toBe("warning");
	expect(render(95, "10", "⣿⣿").get("⣿⣿")).toBe("error");
	expect(render(null, "10", "??").get("??")).toBe("dim");
	expect(render(null, "10", "??").get("10")).toBeUndefined();
	expect(render(80, "?", "⣷⣶").get("?/?")).toBe("muted");
	expect(render(null, "?", "??").get("?/?")).toBe("muted");
});

test("implements exact bridge grammar for title/status combinations", () => {
	const cases = [
		{ snapshot: snapshot(), tail: "─", status: "" },
		{ snapshot: snapshot({ statuses: ["S"] }), tail: "─", status: " · S" },
		{ snapshot: snapshot({ sessionName: "T" }), tail: " T ─", status: "" },
		{
			snapshot: snapshot({ sessionName: "T", statuses: ["S"] }),
			tail: " T ─",
			status: " · S",
		},
	];
	for (const { snapshot: current, tail, status } of cases) {
		const fixed = "─ π · ○ M · ⡀⠀ ?/0";
		const mandatory = visibleWidth(fixed + status + tail);
		for (const [budget, bridge] of [
			[0, ""],
			[1, "─"],
			[3, " ──"],
		] as const) {
			const line = renderStatusbarLine(mandatory + budget, current, theme);
			expect(line).toBe(fixed + status + bridge + tail);
		}
	}
});

test("keeps the title while dropping statuses from right to left", () => {
	const styled = snapshot({
		model: "模型🙂\x1b[31mX\x1b[0m",
		meter: "⣤⣤",
		contextLimit: "10",
		percent: 50,
		sessionName: "標題🙂",
		statuses: ["first", "second", "third"],
	});
	for (const width of [0, 1, 2, 3, 8, 24, 80, 120]) {
		const line = renderStatusbarLine(width, styled, {
			fg: (_role: string, text: string) => `\x1b[31m${text}\x1b[0m`,
		} as never);
		expect(visibleWidth(line)).toBe(width);
		expect(line).not.toContain("\n");
	}
	const narrow = renderStatusbarLine(48, styled, theme);
	expect(narrow).not.toContain("third");
	expect(narrow).toContain("first");
	expect(narrow).toContain("標題🙂");
});

test("keeps exact ANSI output and leaves a narrow model unstyled", () => {
	const ansiTheme = {
		fg: (role: string, text: string) => {
			const code =
				{
					border: 31,
					accent: 32,
					muted: 33,
					text: 34,
					success: 35,
					warning: 36,
					error: 37,
					dim: 90,
				}[role] ?? 39;
			return `\x1b[${code}m${text}\x1b[0m`;
		},
	} as never;
	const current = snapshot({ model: "LongModel" });
	const expected =
		"\x1b[31m─\x1b[0m \x1b[32mπ\x1b[0m \x1b[33m·\x1b[0m \x1b[33m○\x1b[0m \x1b[34mLongModel\x1b[0m \x1b[33m·\x1b[0m \x1b[35m⡀⠀\x1b[0m \x1b[33m?/0\x1b[0m\x1b[31m─\x1b[0m";
	expect(renderStatusbarLine(visibleWidth(expected), current, ansiTheme)).toBe(expected);
	const narrow = renderStatusbarLine(20, current, ansiTheme);
	expect(narrow).not.toContain("\x1b[34m");
	expect(visibleWidth(narrow)).toBe(20);
});
