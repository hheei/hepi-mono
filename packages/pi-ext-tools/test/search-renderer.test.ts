import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { GrepDisplayLine, GrepSubmatch, GrepToolDetails } from "../src/grep.js";
import {
	findCollapsedFooter,
	grepCollapsedFooter,
	renderFindResult,
	renderGrepResult,
} from "../src/search-renderer.js";
import { plainTheme } from "./fixtures/theme.js";

/** The details these tests need; `GrepToolDetails` also carries a budget report nobody here reads. */
type FixtureDetails = Pick<
	GrepToolDetails,
	| "format"
	| "engine"
	| "events"
	| "display"
	| "totalMatched"
	| "totalFiles"
	| "totalLines"
	| "durationMs"
>;

/** One match row; the fields this renderer ignores keep their defaults. */
function matchLine(args: {
	readonly source: string;
	readonly lineNumber?: number;
	readonly submatches?: readonly GrepSubmatch[];
}): GrepDisplayLine {
	return {
		type: "match",
		lineNumber: args.lineNumber ?? 1,
		text: args.source,
		source: args.source,
		visibleStart: 0,
		visibleEnd: args.source.length,
		truncatedLeft: false,
		truncatedRight: false,
		submatches: args.submatches ?? [],
	};
}

function grepResult(
	display: readonly GrepDisplayLine[],
	overrides: Partial<FixtureDetails> = {},
): AgentToolResult<unknown> {
	const details = {
		format: "canonical-grep",
		engine: "rg",
		events: [],
		totalMatched: 1,
		totalFiles: 1,
		totalLines: 1,
		durationMs: 5,
		display,
	} satisfies FixtureDetails;
	return {
		content: [{ type: "text", text: "1 match in 1 file" }],
		details: { ...details, ...overrides },
	};
}

function rendered(result: AgentToolResult<unknown>, expanded = false): string {
	const component = renderGrepResult(result, { expanded, isPartial: false }, plainTheme, {
		isError: false,
		lastComponent: undefined,
	});
	return stripTerminalSequences(component.render(80).join("\n"));
}

describe("search-renderer", () => {
	it("renders a match line far wider than the terminal", () => {
		const source = `const payload = "${"x".repeat(25_000)}";`;
		const result = grepResult([
			matchLine({ source, submatches: [{ start: 6, end: 13, text: "payload" }] }),
		]);

		const output = rendered(result);

		// How long this takes is measured by a benchmark, not here: a wall-clock floor in a test only
		// reports how busy the machine was. What this input pins is that the widest line the grep tool
		// can hand over is still rendered width-safe and keeps its match.
		expect(output).toContain("payload");
		for (const line of output.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	it("maps a match's byte offsets onto characters in multibyte text", () => {
		const source = "const msg = '你好 🌍 世界 🚀';";
		const result = grepResult([
			matchLine({ source, lineNumber: 42, submatches: [{ start: 0, end: 5, text: "const" }] }),
		]);

		expect(rendered(result, true)).toContain(source);
	});

	it("formats the collapsed footer with match counts and timing", () => {
		const result = grepResult([], {
			totalMatched: 14,
			totalFiles: 5,
			totalLines: 63,
			durationMs: 12,
		});

		expect(grepCollapsedFooter(result, undefined)).toBe("14 matches · 5 files · 63 lines · 12ms");
	});

	it("groups find candidates by directory and summarizes them", () => {
		const candidates = [
			{ path: "src/tools/find.ts", matchType: "exact" },
			{ path: "src/tools/grep.ts", matchType: "exact" },
			{ path: "src/root.ts", matchType: "exact" },
		];
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "3 files found" }],
			details: {
				format: "canonical-find",
				candidates,
				totalMatched: 3,
				totalFiles: 3,
				durationMs: 4,
			},
		};

		const output = stripTerminalSequences(
			renderFindResult(result, { expanded: true, isPartial: false }, plainTheme, {
				isError: false,
				lastComponent: undefined,
			})
				.render(80)
				.join("\n"),
		);

		expect(output).toContain("src/tools/");
		expect(findCollapsedFooter(result, undefined)).toContain("3 fuzzy files");
	});
});
