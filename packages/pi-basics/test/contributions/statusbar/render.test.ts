import { describe, expect, test } from "bun:test";
import { buildStatusbarSnapshot } from "../../../src/contributions/statusbar/model.js";
import { renderStatusbarLine } from "../../../src/contributions/statusbar/render.js";
import { visibleWidth } from "../../../src/ui/text.js";

const theme = { fg: (_role: string, text: string) => text } as never;
const snapshot = buildStatusbarSnapshot({
	model: { name: "GPT-5.6" },
	thinkingLevel: "medium",
	usage: { percent: 70, contextWindow: 350000 },
	sessionName: "Session title",
	statuses: new Map([["goal", "active"]]),
});

describe("statusbar renderer", () => {
	test("keeps grammar, status order and right-aligned title", () => {
		const line = renderStatusbarLine(100, snapshot, theme);
		expect(line).toContain("─ π · ◒ GPT-5.6 · ◫ ⣶⣶ 350k · active");
		expect(line.endsWith("Session title ─")).toBe(true);
		expect(visibleWidth(line)).toBe(100);
		expect(line).not.toContain("\n");
	});
	test("degrades narrow rows to one cell-safe line", () => {
		for (const width of [1, 2, 3, 8, 20]) {
			const line = renderStatusbarLine(width, snapshot, theme);
			expect(visibleWidth(line)).toBe(width);
			expect(line).not.toContain("\n");
		}
	});
	test("omits title when absent", () => {
		const line = renderStatusbarLine(80, { ...snapshot, sessionName: undefined }, theme);
		expect(line).not.toContain("Session title");
		expect(line.endsWith("─")).toBe(true);
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
	for (const [level, glyph] of [
		["off", "○"],
		["minimal", "○"],
		["low", "○"],
		["medium", "◒"],
		["high", "●"],
		["xhigh", "●"],
	] as const) {
		calls.length = 0;
		renderStatusbarLine(
			120,
			buildStatusbarSnapshot({
				model: { name: "M" },
				thinkingLevel: level,
				usage: { percent: 50, contextWindow: 10 },
				sessionName: "T",
			}),
			recordingTheme,
		);
		expect(calls.find((call) => call.text === glyph)).toEqual({ role: "muted", text: glyph });
	}
	const roleOf = (text: string) => calls.find((call) => call.text === text)?.role;
	expect(roleOf("π")).toBe("accent");
	expect(roleOf("M")).toBe("text");
	expect(roleOf("T")).toBe("muted");
	expect(roleOf("·")).toBe("muted");
	expect(roleOf("◫")).toBe("muted");
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
	const render = (percent: number | null, contextWindow: number | null) => {
		calls.length = 0;
		renderStatusbarLine(
			120,
			buildStatusbarSnapshot({ model: { name: "M" }, usage: { percent, contextWindow } }),
			recordingTheme,
		);
		return new Map(calls.map((call) => [call.text, call.role]));
	};
	expect(render(50, 10).get("⣤⣤")).toBe("success");
	expect(render(80, 10).get("⣷⣶")).toBe("warning");
	expect(render(95, 10).get("⣿⣿")).toBe("error");
	expect(render(null, 10).get("??")).toBe("dim");
	expect(render(null, 10).get("10")).toBe("text");
	expect(render(80, null).get("⣷⣶")).toBe("warning");
	expect(render(80, null).get("?")).toBe("dim");
	expect(render(null, null).get("?")).toBe("dim");
});

test("implements exact bridge grammar for title/status combinations", () => {
	const cases = [
		{
			snapshot: buildStatusbarSnapshot({
				model: { id: "M" },
				thinkingLevel: "off",
				usage: { percent: 0, contextWindow: 0 },
			}),
			tail: "─",
			status: "",
		},
		{
			snapshot: buildStatusbarSnapshot({
				model: { id: "M" },
				thinkingLevel: "off",
				usage: { percent: 0, contextWindow: 0 },
				statuses: new Map([["s", "S"]]),
			}),
			tail: "─",
			status: " · S",
		},
		{
			snapshot: buildStatusbarSnapshot({
				model: { id: "M" },
				thinkingLevel: "off",
				usage: { percent: 0, contextWindow: 0 },
				sessionName: "T",
			}),
			tail: " T ─",
			status: "",
		},
		{
			snapshot: buildStatusbarSnapshot({
				model: { id: "M" },
				thinkingLevel: "off",
				usage: { percent: 0, contextWindow: 0 },
				sessionName: "T",
				statuses: new Map([["s", "S"]]),
			}),
			tail: " T ─",
			status: " · S",
		},
	];
	for (const { snapshot: current, tail, status } of cases) {
		const fixed = `─ π · ○ M · ◫ ⡀⠀ 0`;
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

test("drops title then statuses from right to left and remains ANSI/cell safe", () => {
	const styled = {
		...buildStatusbarSnapshot({
			model: { name: "模型🙂\x1b[31mX\x1b[0m" },
			usage: { percent: 50, contextWindow: 10 },
			sessionName: "標題🙂",
			statuses: new Map([
				["a", "first"],
				["b", "second"],
				["c", "third"],
			]),
		}),
	};
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
});
