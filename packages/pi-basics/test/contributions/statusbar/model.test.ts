import { describe, expect, test } from "bun:test";
import {
	buildStatusbarSnapshot,
	contextMeter,
	formatContextLimit,
	thinkingGlyph,
} from "../../../src/contributions/statusbar/model.js";

describe("statusbar model", () => {
	test("maps meter states and boundaries", () => {
		expect(contextMeter(0)).toBe("⡀⠀");
		expect(contextMeter(6.25)).toBe("⡀⠀");
		expect(contextMeter(6.2501)).toBe("⣀⠀");
		expect(contextMeter(100)).toBe("⣿⣿");
		expect(contextMeter(undefined)).toBe("??");
	});
	test("formats compact token counts without rollover artifacts", () => {
		expect(formatContextLimit(0)).toBe("0");
		expect(formatContextLimit(999.4)).toBe("999");
		expect(formatContextLimit(999.5)).toBe("1k");
		expect(formatContextLimit(999_949)).toBe("999.9k");
		expect(formatContextLimit(999_950)).toBe("1m");
		expect(formatContextLimit(-1)).toBe("?");
	});
	test("normalizes source precedence, names, statuses and thinking glyph", () => {
		const snapshot = buildStatusbarSnapshot({
			model: { name: "  \n", id: "model-id" },
			thinkingLevel: "medium",
			usage: { contextWindow: 350000, percent: null },
			sessionName: "  Session\nname ",
			statuses: new Map([
				["a", " active "],
				["b", "\n"],
			]),
		});
		expect(snapshot.model).toBe("model-id");
		expect(snapshot.sessionName).toBe("Session name");
		expect(snapshot.statuses).toEqual(["active"]);
		expect(snapshot.meter).toBe("??");
		expect(snapshot.contextLimit).toBe("350k");
		expect(thinkingGlyph("off")).toBe("○");
		expect(thinkingGlyph("medium")).toBe("◒");
		expect(thinkingGlyph("xhigh")).toBe("●");
	});
});

test("covers every approved meter glyph and boundary", () => {
	const glyphs = [
		"⡀⠀",
		"⣀⠀",
		"⣀⡀",
		"⣀⣀",
		"⣄⣀",
		"⣤⣀",
		"⣤⣄",
		"⣤⣤",
		"⣦⣤",
		"⣶⣤",
		"⣶⣦",
		"⣶⣶",
		"⣷⣶",
		"⣿⣶",
		"⣿⣷",
		"⣿⣿",
	];
	for (const [input, output] of [
		[1200, "1.2k"],
		[1249, "1.2k"],
		[350000, "350k"],
		[12345678, "12.3m"],
	] as const)
		expect(formatContextLimit(input)).toBe(output);
	glyphs.forEach((glyph, i) => {
		expect(contextMeter(i * 6.25)).toBe(glyphs[Math.max(0, i - 1)] ?? glyph);
	});
	glyphs.forEach((glyph, i) => {
		expect(contextMeter(i * 6.25 + 0.001)).toBe(glyphs[Math.min(15, i)] ?? glyph);
	});
	expect(contextMeter(101)).toBe(glyphs[15]!);
	expect(contextMeter(-1)).toBe(glyphs[0]!);
	for (const value of [null, NaN, Infinity, -Infinity] as unknown[])
		expect(contextMeter(value)).toBe("??");
});

test("covers formatter examples and invalid values", () => {
	for (const [input, output] of [
		[1200, "1.2k"],
		[1249, "1.2k"],
		[350000, "350k"],
		[12345678, "12.3m"],
	] as const)
		expect(formatContextLimit(input)).toBe(output);
	for (const value of [null, NaN, Infinity, -1]) expect(formatContextLimit(value)).toBe("?");
	for (const level of ["off", "minimal", "low"] as const) expect(thinkingGlyph(level)).toBe("○");
	expect(thinkingGlyph("medium")).toBe("◒");
	for (const level of ["high", "xhigh"] as const) expect(thinkingGlyph(level)).toBe("●");
	expect(thinkingGlyph("bad")).toBe("?");
});
