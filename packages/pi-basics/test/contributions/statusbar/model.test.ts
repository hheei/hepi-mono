import { describe, expect, test } from "bun:test";
import {
	buildStatusbarSnapshot,
	contextMeter,
	estimateContextUsage,
	formatContextLimit,
	formatFooterStatuses,
	RECEIVING_SPINNER_FRAMES,
	stabilizeContextUsage,
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
			usage: { tokens: 123456, contextWindow: 350000, percent: null },
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
		expect(snapshot.contextTokens).toBe("123.5k");
		expect(snapshot.contextLimit).toBe("350k");
		expect(thinkingGlyph("off")).toBe("○");
		expect(thinkingGlyph("minimal")).toBe("○");
		expect(thinkingGlyph("low")).toBe("◔");
		expect(thinkingGlyph("medium")).toBe("◑");
		expect(thinkingGlyph("high")).toBe("◕");
		expect(thinkingGlyph("xhigh")).toBe("●");
		expect(thinkingGlyph("max")).toBe("●");
	});

	test("formats compact MCP and animated receiving statuses for the footer", () => {
		expect(RECEIVING_SPINNER_FRAMES).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
		const display = formatFooterStatuses(
			new Map([
				["mcp", "\x1b[36mMCP: 0/3 servers\x1b[0m"],
				["magic-context", "mc: 85.3K (23%) · idle"],
				["unknown-error-retry", "receiving"],
				["plan", "plan"],
				["goal", "Goal"],
				["other", "retrying"],
			]),
			"⠧",
		);
		expect(display).toEqual({
			values: ["⠧", "⛁ 0/3", "PLAN", "GOAL", "retrying"],
			receiving: true,
			mcpRatio: "0/3",
		});
		expect(
			formatFooterStatuses(new Map([["mcp", "MCP: connecting to filesystem..."]]), "⠋", "2/3"),
		).toEqual({ values: ["⛁ 2/3"], receiving: false, mcpRatio: "2/3" });
		expect(
			formatFooterStatuses(new Map([["mcp", "MCP: connecting to 3 servers..."]]), "⠋"),
		).toEqual({ values: ["⛁ 0/3"], receiving: false, mcpRatio: "0/3" });
	});

	test("uses assembled system prompt tokens before first model response", () => {
		const snapshot = buildStatusbarSnapshot({
			usage: { tokens: 0, contextWindow: 1000, percent: 0 },
			systemPrompt: "x".repeat(400),
		});
		expect(snapshot.contextTokens).toBe("100");
		expect(snapshot.percent).toBe(10);
		expect(snapshot.meter).toBe("⣀⠀");
	});

	test("stabilizes transient usage and estimates compacted context", () => {
		const previous = { tokens: 12_000, contextWindow: 100_000, percent: 12 };
		expect(
			stabilizeContextUsage(
				{ tokens: 7, contextWindow: 100_000, percent: 0.007 },
				previous,
				undefined,
			),
		).toBe(previous);
		const fallback = estimateContextUsage(
			[{ role: "user", content: "x".repeat(400) }],
			1_000,
			"y".repeat(400),
		);
		expect(fallback).toEqual({ tokens: 200, contextWindow: 1_000, percent: 20 });
		expect(stabilizeContextUsage({ tokens: null, contextWindow: 1_000 }, previous, fallback)).toBe(
			fallback,
		);
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
	for (const level of ["off", "minimal"] as const) expect(thinkingGlyph(level)).toBe("○");
	expect(thinkingGlyph("low")).toBe("◔");
	expect(thinkingGlyph("medium")).toBe("◑");
	expect(thinkingGlyph("high")).toBe("◕");
	for (const level of ["xhigh", "max"] as const) expect(thinkingGlyph(level)).toBe("●");
	expect(thinkingGlyph("bad")).toBe("?");
});
