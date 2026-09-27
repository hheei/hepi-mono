import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { renderTimeline } from "../src/commands/timeline.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsRecordedEntry,
	rawMessage,
	type TestEntry,
	textCustomMessage,
} from "./fixtures/session.js";

/** Long messages so a handful of entries spans enough tokens to segment. */
function filler(id: string, chars = 4000): TestEntry {
	return textCustomMessage(id, "x".repeat(chars));
}

describe("om status timeline", () => {
	it("renders an empty strip without crashing", () => {
		const output = renderTimeline([], 80);

		expect(output).toContain("om timeline");
		expect(output).toContain("0 compaction");
		expect(output).toContain("▶");
	});

	it("marks raw backlog, observed pool, and compacted history apart", () => {
		const entries = [
			filler("raw-1"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1", details: memoryDetails() }),
			filler("raw-2"),
			observationsRecordedEntry("om-obs", {
				observations: [observation("aaaaaaaaaaaa")],
				coversUpToId: "raw-2",
			}),
			filler("raw-3"),
		];

		const output = renderTimeline(entries, 80);
		const strip = output.split("\n")[1] ?? "";

		// Compacted history first, then the covered pool, then the raw backlog, tip last.
		expect(strip).not.toContain("░▒");
		expect(strip.indexOf("▓")).toBeLessThan(strip.indexOf("▒"));
		expect(strip.indexOf("▒")).toBeLessThan(strip.indexOf("░"));
		expect(strip.indexOf("░")).toBeLessThan(strip.indexOf("▶"));
		expect(output).toContain("1 compaction");
	});

	it("overlays a cutoff marker at every compaction boundary", () => {
		const entries = [
			filler("raw-1"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			filler("raw-2"),
			compactionEntry("cmp-2", { firstKeptEntryId: "raw-2" }),
			filler("raw-3"),
		];

		const output = renderTimeline(entries, 80);
		const strip = output.split("\n")[1] ?? "";

		expect(strip.split("┊")).toHaveLength(3);
		expect(output).toContain("2 compactions");
	});

	it("bounds every rendered line to the requested width", () => {
		const entries = [filler("raw-1", 40_000), filler("raw-2", 40_000)];

		for (const width of [12, 40, 200]) {
			for (const line of renderTimeline(entries, width).split("\n")) {
				// Pi measures visible cells, not bytes: ANSI resets from truncation do not count.
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("scales the cell size to the terminal width instead of a fixed column count", () => {
		const entries = [filler("raw-1", 40_000)];
		const narrow = renderTimeline(entries, 30).split("\n")[1] ?? "";
		const wide = renderTimeline(entries, 120).split("\n")[1] ?? "";

		expect(visibleWidth(narrow)).toBeLessThanOrEqual(30);
		expect(visibleWidth(wide)).toBeGreaterThan(visibleWidth(narrow));
		expect(visibleWidth(wide)).toBeLessThanOrEqual(120);
	});

	it("keeps a plain conversation unstripped of glyphs other than raw and tip", () => {
		const output = renderTimeline([rawMessage("m-1", "hello"), filler("raw-2")], 80);
		const strip = output.split("\n")[1] ?? "";

		expect(strip).not.toContain("▒");
		expect(strip).not.toContain("▓");
		expect(strip.replaceAll("░", "").replaceAll("▶", "")).toBe("");
	});
});
