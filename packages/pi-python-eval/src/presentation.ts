import { type AgentToolResult, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	agentResultText,
	formatDuration,
	isRecord,
	type ToolPresentation,
	type ToolPresentationContext,
	type ToolPresentationSection,
	type ToolPresentationStatus,
} from "@hheei/pi-ext-core";
import type { EvalNestedTrace } from "./bridge.js";

/** The details format this package persists and reads back; pi-ext-ui mirrors the same string. */
export const PYTHON_EVAL_DETAILS_FORMAT = "pi-ext-tools-python-eval" as const;
export const PYTHON_EVAL_TOOL_NAME = "python_eval";

const MAX_SUMMARY_CHARS = 72;
const MAX_FIRST_LINE_CHARS = 4_000;

/** One row of the cell transcript: printed text, display value, nested call, value, or namespace. */
export type EvalRow =
	| { readonly kind: "text"; text: string }
	| { readonly kind: "display"; readonly text: string }
	| { readonly kind: "tool"; readonly trace: EvalNestedTrace }
	| { readonly kind: "result"; readonly text: string }
	| { readonly kind: "state"; readonly text: string };

export interface EvalToolDetails {
	readonly format: typeof PYTHON_EVAL_DETAILS_FORMAT;
	readonly rows: readonly EvalRow[];
	readonly durationMs: number;
	readonly error?: string;
}

export interface EvalFrameDetails {
	readonly rows: readonly EvalRow[];
	readonly error: string | undefined;
}

/**
 * Reads the persisted details of one cell. Session restore and the UI both hand this package JSON
 * it did not build in this process, so every row is validated here and an unknown shape degrades to
 * plain output instead of a broken frame.
 */
export function readEvalDetails(details: unknown): EvalFrameDetails | undefined {
	if (!isRecord(details) || details.format !== PYTHON_EVAL_DETAILS_FORMAT) return undefined;
	const rawRows = Array.isArray(details.rows) ? details.rows : [];
	const rows: EvalRow[] = [];
	for (const entry of rawRows) {
		if (!isRecord(entry)) continue;
		if (
			(entry.kind === "text" ||
				entry.kind === "display" ||
				entry.kind === "result" ||
				entry.kind === "state") &&
			typeof entry.text === "string"
		) {
			rows.push({ kind: entry.kind, text: entry.text });
		} else if (entry.kind === "tool") {
			const trace = readTrace(entry.trace);
			if (trace !== undefined) rows.push({ kind: "tool", trace });
		}
	}
	return { rows, error: typeof details.error === "string" ? details.error : undefined };
}

function readTrace(raw: unknown): EvalNestedTrace | undefined {
	if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.text !== "string")
		return undefined;
	return {
		name: raw.name as EvalNestedTrace["name"],
		args: raw.args,
		text: raw.text,
		details: raw.details,
		durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
		...(typeof raw.error === "string" ? { error: raw.error } : {}),
		...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
	};
}

/**
 * The rich frame of one python_eval execution, owned by this package.
 *
 * The call row carries the cell source; the result row carries the cell transcript, with the
 * kernel's namespace report muted, `display:`/`result:` prefixes on values, and one header row per
 * nested tool call. A generic UI shell draws the frame and interaction around these facts.
 */
export function createPythonEvalPresentation(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
	theme: Theme,
	context: ToolPresentationContext,
): ToolPresentation {
	const parsed = isRecord(args) ? args : undefined;
	const code = typeof parsed?.code === "string" ? parsed.code.trim() : "";
	const facts = result === undefined ? undefined : readEvalDetails(result.details);
	const toolRows = facts?.rows.filter((row) => row.kind === "tool") ?? [];
	const toolFailures = toolRows.filter((row) => row.trace.error !== undefined).length;
	const isError = context.isError || result?.isError === true;
	const selfFailed = (isError || facts?.error !== undefined) && toolFailures === 0;

	const status: ToolPresentationStatus | undefined =
		result === undefined
			? undefined
			: resolveContainerStatus({
					isError,
					isPartial: context.isPartial,
					hasChildren: toolRows.length > 0,
					selfFailed,
				});

	// The frame appends the duration, so the summary carries only what the cell itself says. The
	// deadline is not repeated here either: it is the same 180s for nearly every cell, and a row that
	// always names it costs the width a reader needs for the result.
	const options = parsed?.reset === true ? ["(reset)"] : [];
	// Before any result exists the row still has to say what the cell will run.
	const summary =
		result === undefined
			? [firstCodeLine(code) || "(empty)", ...options].join(" · ")
			: [
					...options,
					...callStats(toolRows.length, toolFailures),
					...(toolRows.length === 0 && facts !== undefined && facts.rows.length > 0
						? [`${String(facts.rows.length)} ${facts.rows.length === 1 ? "row" : "rows"}`]
						: []),
				]
					.filter((part): part is string => part !== undefined && part !== "")
					.join(" · ");

	const transcript = transcriptRows(facts, result, isError, theme);
	const source = inputSection(code, theme);
	const sections: ToolPresentationSection[] = [
		...(source === undefined ? [] : [source]),
		...(transcript.length === 0
			? []
			: [{ railToken: isError ? ("error" as const) : ("success" as const), content: transcript }]),
	];

	const output = result === undefined ? "" : stripTerminalSequences(agentResultText(result));
	return {
		summary,
		...(status === undefined ? {} : { status }),
		// A cell reports rows as soon as they exist, so its own frame replaces the call row.
		replaceCallOnPartial: true,
		request: code,
		sections,
		...(toolRows.length === 0
			? {}
			: { collapsedRows: toolRows.map((row) => formatToolRow(row, theme)) }),
		...(code === ""
			? output === ""
				? {}
				: { copy: { primary: output } }
			: { copy: { primary: code, full: output === "" ? code : `${code}\n---\n${output}` } }),
		output,
	};
}

/** The cell source, highlighted as Python. Empty source yields no section at all. */
function inputSection(code: string, theme: Theme): ToolPresentationSection | undefined {
	if (code === "") return undefined;
	const clean = code.replace(/\r/g, "").replace(/\t/g, "  ");
	let lines: string[];
	try {
		lines = highlightCode(clean, "python");
	} catch {
		lines = clean.split("\n").map((line) => theme.fg("mdCode", line));
	}
	return { railToken: "muted", content: lines };
}

/**
 * The transcript the result row shows. A cell with persisted details renders its rows; one without
 * them (an interrupted call, an older session) falls back to the plain text it produced.
 */
function transcriptRows(
	facts: EvalFrameDetails | undefined,
	result: AgentToolResult<unknown> | undefined,
	isError: boolean,
	theme: Theme,
): readonly string[] {
	if (facts === undefined) {
		if (result === undefined) return [];
		const text = stripTerminalSequences(agentResultText(result));
		if (text === "") return [];
		return text.split("\n").map((line) => theme.fg(isError ? "error" : "dim", line));
	}
	const rows: string[] = [];
	for (const row of facts.rows) {
		switch (row.kind) {
			case "tool":
				rows.push(formatToolRow(row, theme));
				break;
			case "state":
				// The namespace report is metadata about the cell, not its output, so it stays muted.
				rows.push(theme.fg("muted", row.text));
				break;
			case "display":
			case "result": {
				const prefix = theme.fg("dim", `${row.kind}:`);
				const lines = row.text.replace(/\r/g, "").split("\n");
				for (const [index, line] of lines.entries()) {
					const text = theme.fg("dim", line);
					rows.push(index === 0 ? `${prefix} ${text}` : `  ${text}`);
				}
				break;
			}
			default:
				if (row.text === "") break;
				rows.push(
					...row.text
						.replace(/\r/g, "")
						.split("\n")
						.map((line) => theme.fg(isError ? "error" : "dim", line)),
				);
		}
	}
	return rows;
}

/** One nested call: status glyph, tool name, its argument summary, and its duration. */
function formatToolRow(row: Extract<EvalRow, { kind: "tool" }>, theme: Theme): string {
	const failed = row.trace.error !== undefined;
	const glyph = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const title = theme.fg("toolTitle", theme.bold(row.trace.name));
	const summary = [nestedSummary(row.trace), formatDuration(row.trace.durationMs)]
		.filter((part): part is string => part !== undefined && part !== "")
		.join(" · ");
	return `${glyph} ${title}${summary === "" ? "" : ` ${theme.fg("dim", summary)}`}`;
}

/** The part of a nested call's arguments that reads as a summary, bounded to one row. */
function nestedSummary(trace: EvalNestedTrace): string {
	const raw =
		typeof trace.args === "string"
			? trace.args
			: isRecord(trace.args)
				? firstArgumentText(trace.args)
				: "";
	const clean = stripTerminalSequences(raw.trim().replace(/[\r\n\t]+/g, " "));
	return clean.length > MAX_SUMMARY_CHARS ? `${clean.slice(0, MAX_SUMMARY_CHARS - 3)}…` : clean;
}

function firstArgumentText(args: Record<string, unknown>): string {
	for (const key of ["command", "path", "file_path", "pattern", "query", "glob", "url"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return "";
}

/** A container reports no status of its own once it has child rows to speak for it. */
function resolveContainerStatus(params: {
	readonly isError: boolean;
	readonly isPartial: boolean;
	readonly hasChildren: boolean;
	readonly selfFailed: boolean;
}): ToolPresentationStatus {
	if (params.selfFailed) return "error";
	if (params.hasChildren) return "none";
	if (params.isPartial) return "running";
	return params.isError ? "error" : "ok";
}

function callStats(total: number, failures: number): string[] {
	if (total === 0) return [];
	if (failures > 0) return [`${String(total - failures)} ok`, `${String(failures)} failed`];
	return [`${String(total)} ${total === 1 ? "call" : "calls"}`];
}

/** One bounded line naming what a cell will run, used by the plain native call row. */
export function firstCodeLine(code: string): string {
	const [line = ""] = code.split("\n");
	const trimmed = line.trim();
	return trimmed.length <= MAX_FIRST_LINE_CHARS
		? trimmed
		: `${trimmed.slice(0, MAX_FIRST_LINE_CHARS)}…`;
}
