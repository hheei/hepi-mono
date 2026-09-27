import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	type Entry,
	entryIndexById,
	isSourceEntry,
	latestCoverageIndex,
	OM_OBSERVATIONS_RECORDED,
} from "../session-ledger/index.js";
import { estimateEntryTokens } from "../tokens.js";

const GLYPH = {
	compacted: "▓",
	pool: "▒",
	raw: "░",
	cut: "┊",
	tip: "▶",
} as const;

function fmtK(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Cumulative raw tokens in front of every entry, plus the session total.
 *
 * Only source entries carry history; ledger and compaction entries are bookkeeping and
 * cost nothing on this scale.
 */
function tokenOffsets(entries: Entry[]): { starts: number[]; total: number } {
	const starts: number[] = [];
	let total = 0;
	for (const entry of entries) {
		starts.push(total);
		if (isSourceEntry(entry)) total += estimateEntryTokens(entry);
	}
	return { starts, total };
}

/** Token positions where a compaction cutoff landed, oldest first. */
function cutoffPositions(entries: Entry[], starts: number[]): number[] {
	const indexById = entryIndexById(entries);
	const positions: number[] = [];
	for (const entry of entries) {
		if (entry.type !== "compaction" || !entry.firstKeptEntryId) continue;
		const index = indexById.get(entry.firstKeptEntryId);
		if (index === undefined) continue;
		positions.push(starts[index] ?? 0);
	}
	return positions.sort((a, b) => a - b);
}

/**
 * Render the session as one horizontal strip, oldest on the left, tip on the right; the
 * glyph legend below the strip names each segment, and the cell size adapts to `width` so
 * the strip stays a single line. `width` must be the real terminal width: Pi errors out
 * when a rendered line overflows it.
 */
export function renderTimeline(entries: Entry[], width: number): string {
	const available = Math.max(1, Math.floor(width));
	const { starts, total } = tokenOffsets(entries);
	const cuts = cutoffPositions(entries, starts);
	const newestCut = cuts.at(-1) ?? 0;

	// Seam between the observer's coverage and the raw backlog: the token position right
	// after the newest covered source entry.
	const coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const coveredTokens = coverageIndex < 0 ? 0 : (starts[coverageIndex + 1] ?? total);

	// Cut markers take width too, so the cell scale reserves one column per marker up
	// front; that keeps `cells + markers + tip` inside the requested width.
	const cellBudget = Math.max(1, available - 1 - cuts.length);
	const stepTokens = Math.max(1, Math.ceil(total / cellBudget));
	const cellCount =
		total === 0 ? 0 : Math.max(1, Math.min(cellBudget, Math.ceil(total / stepTokens)));
	const cells: string[] = [];
	for (let cell = 0; cell < cellCount; cell++) {
		const position = cell * stepTokens;
		if (position < newestCut) cells.push(GLYPH.compacted);
		else if (position < coveredTokens) cells.push(GLYPH.pool);
		else cells.push(GLYPH.raw);
	}

	// Overlay cutoffs right-to-left so earlier insertions keep their positions.
	const markers = new Set(cuts.map((cut) => Math.min(cells.length, Math.floor(cut / stepTokens))));
	for (const position of Array.from(markers).sort((a, b) => b - a)) {
		cells.splice(position, 0, GLYPH.cut);
	}

	const header = `om timeline · 1 cell ≈ ${fmtK(stepTokens)} tok · ${fmtK(total)} raw · ${cuts.length} compaction${cuts.length === 1 ? "" : "s"}`;
	const legend = `  ${GLYPH.compacted} compacted   ${GLYPH.pool} memory pool   ${GLYPH.raw} raw backlog   ${GLYPH.cut} cut   ${GLYPH.tip} tip`;

	return [header, `${cells.join("")}${GLYPH.tip}`, "", legend]
		.map((line) => truncateToWidth(line, available, ""))
		.join("\n");
}
