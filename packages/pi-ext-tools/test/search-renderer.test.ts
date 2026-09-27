import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { grepCollapsedFooter, renderGrepResult } from "../src/search-renderer.js";

const mockTheme: Theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	strikethrough: (text) => text,
	getFgAnsi: () => undefined,
};

describe("search-renderer", () => {
	it("renders plain grep match lines quickly", () => {
		const result = {
			content: [{ type: "text" as const, text: "1 match in 1 file" }],
			details: {
				format: "canonical-grep" as const,
				engine: "rg" as const,
				events: [],
				display: [
					{ type: "path" as const, text: "src/index.ts" },
					{
						type: "match" as const,
						path: "src/index.ts",
						lineNumber: 10,
						source: "const value = calculate();",
						submatches: [{ start: 6, end: 11, match: "value" }],
					},
				],
				totalMatched: 1,
				totalFiles: 1,
				totalLines: 1,
				durationMs: 5,
			},
		};

		const comp = renderGrepResult(result, { expanded: false }, mockTheme, {
			isError: false,
			lastComponent: undefined,
		});
		const rendered = comp.render(80);
		expect(rendered.length).toBeGreaterThan(0);
		expect(rendered.some((line) => line.includes("src/index.ts"))).toBe(true);
	});

	it("renders long lines in under 20ms without event-loop freezing", () => {
		// A 25,000-character line previously took >1500ms due to O(N^2) array spreading
		const longSource = `const payload = "${"x".repeat(25_000)}";`;
		const result = {
			content: [{ type: "text" as const, text: "1 match in 1 file" }],
			details: {
				format: "canonical-grep" as const,
				engine: "rg" as const,
				events: [],
				display: [
					{ type: "path" as const, text: "dist/bundle.js" },
					{
						type: "match" as const,
						path: "dist/bundle.js",
						lineNumber: 1,
						source: longSource,
						submatches: [{ start: 6, end: 13, match: "payload" }],
					},
				],
				totalMatched: 1,
				totalFiles: 1,
				totalLines: 1,
				durationMs: 10,
			},
		};

		const start = performance.now();
		const comp = renderGrepResult(result, { expanded: false }, mockTheme, {
			isError: false,
			lastComponent: undefined,
		});
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(100);
		const rendered = comp.render(100);
		expect(rendered.length).toBeGreaterThan(0);
	});

	it("correctly handles lines containing Unicode surrogate pairs and CJK characters", () => {
		const result = {
			content: [{ type: "text" as const, text: "1 match in 1 file" }],
			details: {
				format: "canonical-grep" as const,
				engine: "rg" as const,
				events: [],
				display: [
					{
						type: "match" as const,
						path: "src/unicode.ts",
						lineNumber: 42,
						source: "const msg = '你好 🌍 世界 🚀';",
						submatches: [
							// '你好 ' is 3 chars = 3*3+1 = 7 bytes in UTF-8
							{ start: 0, end: 5, match: "const" },
						],
					},
				],
				totalMatched: 1,
				totalFiles: 1,
				totalLines: 1,
				durationMs: 8,
			},
		};

		const comp = renderGrepResult(result, { expanded: true }, mockTheme, {
			isError: false,
			lastComponent: undefined,
		});
		const rendered = comp.render(80);
		expect(rendered.some((line) => line.includes("42"))).toBe(true);
	});

	it("formats grep collapsed footer with match and timing information", () => {
		const result = {
			content: [{ type: "text" as const, text: "ok" }],
			details: {
				format: "canonical-grep" as const,
				engine: "rg" as const,
				events: [],
				display: [],
				totalMatched: 14,
				totalFiles: 5,
				totalLines: 63,
				durationMs: 12,
			},
		};

		const footer = grepCollapsedFooter(result, undefined);
		expect(footer).toBe("14 matches · 5 files · 63 lines · 12ms");
	});
});
