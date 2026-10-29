import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { EvalNestedTrace } from "./bridge.js";
import {
	callFact,
	type EvalCall,
	type EvalRow,
	type EvalTrace,
	summarizeTraceArgs,
} from "./presentation.js";

/** Most a preview row keeps of one line; the rest stays in the output ledger. */
const MAX_DETAIL_TEXT_CHARS = 4_000;
/** Most rows the preview keeps, before the reserved slots below. */
const MAX_DETAIL_ROWS = 200;
/** Slots the namespace, the final value, and the failure keep beyond the preview cap. */
const KEEP_ROW_RESERVE = 4;
/**
 * Ceiling for the cell's complete output. It is held in memory until the cell ends, because the
 * model body and the spilled file must carry what the bounded preview dropped, so the buffer needs
 * a limit of its own; a cell past it says so instead of growing without bound.
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * One cell's transcript: the complete output, the bounded preview the UI draws, and the rules that
 * keep the two in the same order.
 *
 * Every event that is not printed output ends the line being printed before it records itself, so an
 * interleaved `print`, `display` and nested call cannot put the preview and the body in different
 * orders. A caller submits events and reads the result; it never decides when a line ends.
 */
export class CellTranscript {
	readonly rows: EvalRow[] = [];
	/** Nested calls as facts, kept apart from the preview that may drop their rows. */
	readonly calls: EvalCall[] = [];
	readonly #output = new CellOutput();
	readonly #onChange: () => void;
	#printedLine = "";
	#printedRow: { kind: "text"; text: string } | undefined;
	#omitted = 0;
	#total = 0;
	#failed = 0;

	constructor(onChange: () => void) {
		this.#onChange = onChange;
	}

	/** The nested calls as the details report them: counts are facts, the list is bounded. */
	get callsFact(): {
		readonly total: number;
		readonly failed: number;
		readonly items: readonly EvalCall[];
	} {
		return { total: this.#total, failed: this.#failed, items: this.calls };
	}

	/**
	 * Printed output. A chunk may hold several complete lines, a partial line, or both; a line the
	 * kernel sends in pieces is rewritten in place rather than becoming one row per piece.
	 */
	text(chunk: string): void {
		const clean = chunk.replace(/\r/g, "");
		this.#output.write(clean);
		const lines = clean.split("\n");
		const tail = lines.pop() ?? "";
		for (const line of lines) {
			this.#printedLine = (this.#printedLine + line).slice(0, MAX_DETAIL_TEXT_CHARS + 1);
			this.#paint();
			this.#printedLine = "";
			this.#printedRow = undefined;
		}
		if (tail === "") return;
		this.#printedLine = (this.#printedLine + tail).slice(0, MAX_DETAIL_TEXT_CHARS + 1);
		this.#paint();
	}

	display(value: unknown): void {
		const text = inspectValue(value);
		this.#event({ kind: "display", text: boundedText(text) }, `display: ${text}`);
	}

	/** Output the kernel could not attribute to a cell: a detached task, thread, or raw fd write. */
	background(text: string): void {
		const clean = stripTerminalSequences(text.replace(/\r/g, "").trimEnd());
		this.#event({ kind: "text", text: boundedText(clean) }, clean);
	}

	tool(trace: EvalNestedTrace): void {
		this.#total += 1;
		if (trace.error !== undefined) this.#failed += 1;
		const preview = boundedTrace(trace);
		if (this.calls.length < MAX_DETAIL_ROWS) this.calls.push(callFact(preview));
		this.#event({ kind: "tool", trace: preview }, toolLine(trace));
	}

	state(text: string): void {
		this.#event({ kind: "state", text }, text, true);
	}

	result(value: unknown): void {
		const text = inspectValue(value);
		this.#event({ kind: "result", text: boundedText(text) }, `result: ${text}`, true);
	}

	/** The cell failed. Its message is the row a reader cannot lose to the preview cap. */
	fail(message: string): void {
		this.#event(
			{ kind: "text", text: `error: ${boundedText(message)}` },
			`error: ${message}`,
			true,
		);
	}

	/** Ends the open line and reports what the preview dropped. Call once, when the cell is over. */
	finish(): void {
		this.#closeLine();
		if (this.#omitted > 0) {
			// The hint takes a row of its own rather than displacing one: the row it would push out is the
			// failure, which is the one row that must survive.
			this.rows.push({
				kind: "text",
				text: `… ${String(this.#omitted)} more output row(s) omitted`,
			});
		}
	}

	/** The preview as plain text, for the streaming update. */
	body(): string {
		return this.rows.map(rowText).join("\n");
	}

	/** The complete output, up to the ledger ceiling. */
	output(): string {
		return this.#output.text();
	}

	#event(row: EvalRow, raw: string, keep = false): void {
		// The fix: an event between two printed chunks closes the line, so both views agree on order.
		this.#closeLine();
		this.#output.line(raw);
		this.#append(row, keep);
	}

	#paint(): void {
		const text = boundedText(stripTerminalSequences(this.#printedLine));
		if (this.#printedRow === undefined) {
			this.#printedRow = { kind: "text", text };
			this.#append(this.#printedRow, false);
			return;
		}
		if (this.#printedRow.text === text) return;
		this.#printedRow.text = text;
		this.#onChange();
	}

	/** Ends the line being printed, if any. A blank line that already reached the preview is not one. */
	#closeLine(): void {
		if (this.#printedRow === undefined && this.#printedLine === "") return;
		this.#paint();
		this.#printedLine = "";
		this.#printedRow = undefined;
	}

	/**
	 * The preview is bounded; the output ledger is not, up to its own byte ceiling. A `keep` row may
	 * use the reserved slots past the cap, because the rows it would otherwise push out are the ones a
	 * reader cannot do without.
	 */
	#append(row: EvalRow, keep: boolean): void {
		const limit = keep ? MAX_DETAIL_ROWS + KEEP_ROW_RESERVE : MAX_DETAIL_ROWS;
		if (this.rows.length < limit) this.rows.push(row);
		else if (keep) {
			this.rows.pop();
			this.#omitted += 1;
			this.rows.push(row);
		} else this.#omitted += 1;
		this.#onChange();
	}
}

/** One row as a transcript line. The preview and the output ledger share it, so they never drift. */
function rowText(row: EvalRow): string {
	switch (row.kind) {
		case "tool":
			return toolLine(row.trace);
		case "display":
			return `display: ${row.text}`;
		case "result":
			return `result: ${row.text}`;
		default:
			return row.text;
	}
}

function toolLine(trace: {
	readonly name: string;
	readonly text: string;
	readonly error?: string;
}): string {
	return `${trace.name}: ${trace.error ?? trace.text}`;
}

/**
 * The cell's complete output, kept apart from the bounded preview the UI draws.
 *
 * A cell that prints past the preview cap, or prints a single enormous line, still has to hand the
 * model a recoverable file. Output is metered as it arrives, not after a line is assembled, so the
 * buffer cannot grow past its ceiling while waiting for a newline; once the ceiling is reached it
 * stops and says so, and a runaway cell costs a bounded buffer instead of the process.
 */
class CellOutput {
	readonly #lines: string[] = [];
	#bytes = 0;
	#overflowed = false;
	#lineOpen = false;

	/** Raw output exactly as it arrived; the caller owns its newlines. */
	write(text: string): void {
		if (text === "" || !this.#accept(text)) return;
		this.#lines.push(text);
		this.#lineOpen = !text.endsWith("\n");
	}

	/** One complete transcript line, on a line of its own. */
	line(text: string): void {
		if (this.#lineOpen) this.write("\n");
		this.write(`${text}\n`);
	}

	#accept(text: string): boolean {
		if (this.#overflowed) return false;
		const size = Buffer.byteLength(text, "utf8");
		if (this.#bytes + size > MAX_OUTPUT_BYTES) {
			this.#overflowed = true;
			return false;
		}
		this.#bytes += size;
		return true;
	}

	text(): string {
		// Cleaned once, here: a terminal sequence split across two chunks is only whole in the joined text.
		const joined = stripTerminalSequences(this.#lines.join(""));
		const body = joined.endsWith("\n") ? joined.slice(0, -1) : joined;
		if (!this.#overflowed) return body;
		const limit = `${String(Math.round(MAX_OUTPUT_BYTES / (1024 * 1024)))}MB`;
		return `${body}\n… output stopped at ${limit}; the rest of this cell was not kept …`;
	}
}

function boundedText(text: string): string {
	return text.length <= MAX_DETAIL_TEXT_CHARS
		? text
		: `${text.slice(0, MAX_DETAIL_TEXT_CHARS)}\n… truncated`;
}

/**
 * The nested call as the persisted details keep it: the bounded result text a child row opens, and
 * the argument summary it shows. The arguments themselves are not persisted — the row never draws
 * them, and keeping a reshaped copy would let a display limit change their type.
 */
function boundedTrace(trace: EvalNestedTrace): EvalTrace {
	return {
		name: trace.name,
		text: boundedText(trace.text),
		summary: summarizeTraceArgs(trace.args),
		durationMs: trace.durationMs,
		...(trace.error === undefined ? {} : { error: boundedText(trace.error) }),
		...(trace.toolCallId === undefined ? {} : { toolCallId: trace.toolCallId }),
	};
}

/** How a value reads as one transcript line: JSON when it is safe to serialize, a type summary else. */
function inspectValue(value: unknown): string {
	if (isJsonSafe(value)) {
		try {
			return JSON.stringify(value) ?? String(value);
		} catch {
			return typeSummary(value);
		}
	}
	return typeSummary(value);
}

function isJsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.every((item) => isJsonSafe(item, seen));
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.values(value).every((item) => isJsonSafe(item, seen));
}

function typeSummary(value: unknown): string {
	if (value === undefined) return "[undefined]";
	if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
	if (typeof value === "object" && value !== null)
		return `[${value.constructor?.name ?? typeof value}]`;
	return `[${typeof value}]`;
}
