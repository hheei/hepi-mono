import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** One displayed diff row. `line` is 1-based: old file for `del`, new file otherwise. */
export interface DiffLine {
	readonly kind: "add" | "del" | "ctx";
	readonly line: number;
	readonly text: string;
}

/** One contiguous change region, in display order. */
export interface DiffHunk {
	readonly lines: readonly DiffLine[];
}

/**
 * Real diff sources, never a partially populated patch/before/after bag:
 * a standard unified patch (what Pi native edit persists as `details.patch`) or
 * hunks a caller already parsed.
 */
export type DiffSource =
	| { readonly kind: "unifiedPatch"; readonly text: string }
	| { readonly kind: "hunks"; readonly hunks: readonly DiffHunk[] };

export interface DiffStats {
	readonly added: number;
	readonly removed: number;
}

export interface DiffViewOptions {
	readonly theme: Theme;
	readonly source: DiffSource;
}

type ParseOutcome =
	| {
			readonly ok: true;
			readonly hunks: readonly DiffHunk[];
			readonly stats: DiffStats;
	  }
	| { readonly ok: false; readonly diagnostic: string };

type DiffToken = "success" | "error" | "dim";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const PATCH_HEADER =
	/^(diff --git |diff -|index |--- |\+\+\+ |old mode |new mode |new file|deleted file|similarity index|rename |copy |Binary files )/;
const MIN_NUMBER_WIDTH = 2;
/** Tab width used for layout only; copy text keeps the original bytes. */
const TAB_WIDTH = 2;

function parseUnifiedPatch(text: string): ParseOutcome {
	if (text.trim() === "") return { ok: false, diagnostic: "empty patch" };
	const rawLines = text.split(/\r?\n/);
	const hunks: DiffHunk[] = [];
	let added = 0;
	let removed = 0;
	let bodyLines = 0;
	let current: DiffLine[] | undefined;
	let oldNum = 0;
	let newNum = 0;

	for (let index = 0; index < rawLines.length; index += 1) {
		const raw = rawLines[index] ?? "";
		if (raw.startsWith("@@")) {
			const header = HUNK_HEADER.exec(raw);
			if (header === null) return { ok: false, diagnostic: `invalid hunk header: ${raw}` };
			if (current !== undefined) hunks.push({ lines: current });
			current = [];
			oldNum = Number(header[1]);
			newNum = Number(header[2]);
			continue;
		}
		if (raw.startsWith("\\")) continue;
		if (current === undefined) {
			if (raw === "" || PATCH_HEADER.test(raw)) continue;
			return { ok: false, diagnostic: `unexpected line before the first hunk: ${raw}` };
		}
		if (raw === "") {
			if (index === rawLines.length - 1) break;
			return { ok: false, diagnostic: "hunk line without a change sign" };
		}
		const sign = raw.charAt(0);
		const body = raw.slice(1);
		if (sign === "+") {
			current.push({ kind: "add", line: newNum, text: body });
			newNum += 1;
			added += 1;
		} else if (sign === "-") {
			current.push({ kind: "del", line: oldNum, text: body });
			oldNum += 1;
			removed += 1;
		} else if (sign === " ") {
			current.push({ kind: "ctx", line: newNum, text: body });
			oldNum += 1;
			newNum += 1;
		} else {
			return { ok: false, diagnostic: `unsupported hunk line: ${raw}` };
		}
		bodyLines += 1;
	}

	if (current !== undefined) hunks.push({ lines: current });
	if (bodyLines === 0) return { ok: false, diagnostic: "no hunks found" };
	return { ok: true, hunks, stats: { added, removed } };
}

function summarizeHunks(hunks: readonly DiffHunk[]): ParseOutcome {
	let added = 0;
	let removed = 0;
	let bodyLines = 0;
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			bodyLines += 1;
			if (line.kind === "add") added += 1;
			else if (line.kind === "del") removed += 1;
		}
	}
	if (bodyLines === 0) return { ok: false, diagnostic: "no hunks found" };
	return { ok: true, hunks, stats: { added, removed } };
}

function parseSource(source: DiffSource): ParseOutcome {
	return source.kind === "unifiedPatch"
		? parseUnifiedPatch(source.text)
		: summarizeHunks(source.hunks);
}

/** Counts from the same interpretation the DiffView body renders. */
export function diffStats(source: DiffSource): DiffStats | undefined {
	const parsed = parseSource(source);
	return parsed.ok ? parsed.stats : undefined;
}

function numberWidth(hunks: readonly DiffHunk[]): number {
	let max = 0;
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.line > max) max = line.line;
		}
	}
	return Math.max(MIN_NUMBER_WIDTH, String(max).length);
}

function lineToken(kind: DiffLine["kind"]): DiffToken {
	if (kind === "add") return "success";
	if (kind === "del") return "error";
	return "dim";
}

function lineSign(kind: DiffLine["kind"]): string {
	if (kind === "add") return "+";
	if (kind === "del") return "-";
	return " ";
}

/**
 * Unified single-column diff body for the ToolView rail. One space between the
 * sign/line number and the source, right-aligned numbers, no right-side bar and
 * no split columns. Wrapped continuation rows repeat neither sign nor number.
 * A patch that cannot be parsed keeps its raw text behind a short diagnostic.
 */
export class DiffView implements Component {
	readonly #theme: Theme;
	readonly #parsed: ParseOutcome;
	readonly #rawText: string | undefined;
	#cache: { readonly width: number; readonly rows: string[] } | undefined;

	constructor(options: DiffViewOptions) {
		this.#theme = options.theme;
		this.#rawText = options.source.kind === "unifiedPatch" ? options.source.text : undefined;
		this.#parsed = parseSource(options.source);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.#cache?.width === safeWidth) return this.#cache.rows;
		const rows = this.#parsed.ok
			? this.#renderDiff(safeWidth, this.#parsed.hunks)
			: this.#renderRaw(safeWidth);
		this.#cache = { width: safeWidth, rows };
		return rows;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	#renderRaw(width: number): string[] {
		const rows: string[] = [];
		if (!this.#parsed.ok) rows.push(this.#theme.fg("warning", `! ${this.#parsed.diagnostic}`));
		for (const raw of (this.#rawText ?? "").split(/\r?\n/)) {
			rows.push(this.#theme.fg("dim", raw));
		}
		return rows.map((row) => truncateToWidth(row, width, "…"));
	}

	#renderDiff(width: number, hunks: readonly DiffHunk[]): string[] {
		const numberCol = numberWidth(hunks);
		const gutterWidth = numberCol + 2;
		const contentWidth = Math.max(1, width - gutterWidth);
		const continuation = " ".repeat(gutterWidth);
		const rows: string[] = [];

		let isFirstHunk = true;
		for (const hunk of hunks) {
			if (!isFirstHunk) {
				rows.push(this.#theme.fg("dim", ` ${"…".padStart(numberCol)}`));
			}
			isFirstHunk = false;
			for (const line of hunk.lines) {
				const token = lineToken(line.kind);
				const prefix = `${lineSign(line.kind)}${String(line.line).padStart(numberCol)} `;
				const wrapped = wrapTextWithAnsi(
					line.text.replace(/\t/g, " ".repeat(TAB_WIDTH)),
					contentWidth,
				);
				for (let row = 0; row < wrapped.length; row += 1) {
					const head = row === 0 ? prefix : continuation;
					rows.push(this.#theme.fg(token, `${head}${wrapped[row] ?? ""}`));
				}
			}
		}

		return rows.map((row) => truncateToWidth(row, width, "…"));
	}
}
