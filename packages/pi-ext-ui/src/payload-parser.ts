import { type AgentToolResult, formatReadLineRange } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { previewV4aOperations } from "./apply-patch-preview.js";
import { applyPatchFacts } from "./apply-patch-view.js";
import { type DiffLine, type DiffSource, diffStats } from "./diff-view.js";
import type { ToolStatusKind } from "./tool-view.js";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";
export const PYTHON_EVAL_TOOL_NAME = "python_eval";
export const PYTHON_EVAL_DETAILS_FORMAT = "pi-ext-tools-python-eval";
export const EDIT_TOOL_NAME = "edit";
export const WRITE_TOOL_NAME = "write";
export const EDIT_VIEW_KEY = "__piExtToolsEditView";
export const WRITE_VIEW_KEY = "__piExtToolsWriteView";
export const CODEMODE_OPTIONS_PREFIX = "// @options:";
export const CODEMODE_SCRIPT_HEADER =
	/^Script (?:completed|failed)\r?\nWall time ([\d.]+) seconds\r?\nOutput:\r?\n/;

export interface NestedCallRecord {
	readonly toolName: string;
	readonly summary?: string | undefined;
	readonly status?: "running" | "ok" | "error" | "cancelled" | undefined;
	readonly isError?: boolean | undefined;
	readonly isWarning?: boolean | undefined;
	readonly durationMs?: number | undefined;
	readonly cost?: number | undefined;
	readonly error?: string | undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function estimateStreamingTokens(args: unknown): number {
	if (args === undefined || args === null) return 0;
	try {
		const serialized = typeof args === "string" ? args : JSON.stringify(args);
		if (!serialized || serialized === "{}") return 0;
		return Math.max(1, Math.ceil(serialized.length / 4));
	} catch {
		return 0;
	}
}

export function formatDurationMs(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	return ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatCostUsd(cost: number | undefined): string {
	if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return "";
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

/** One header fact for a deadline, in the same shape codemode's `timeout_ms` renders as. */
export function formatTimeoutFact(timeoutMs: number): string {
	const label =
		timeoutMs >= 1000 ? `${String(Math.round(timeoutMs / 1000))}s` : `${String(timeoutMs)}ms`;
	return `(timeout ${label})`;
}

export function extractCodemodeHeaderFacts(args: unknown): string {
	if (!isRecord(args)) return "";
	const options: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (key !== "code" && value !== undefined && value !== null) {
			options[key] = value;
		}
	}
	if (typeof args.code === "string") {
		const firstLine = args.code.split(/\r?\n/, 1)[0]?.trim() ?? "";
		if (firstLine.startsWith(CODEMODE_OPTIONS_PREFIX)) {
			try {
				const parsed: unknown = JSON.parse(firstLine.slice(CODEMODE_OPTIONS_PREFIX.length).trim());
				if (isRecord(parsed)) {
					Object.assign(options, parsed);
				}
			} catch {}
		}
	}
	const facts: string[] = [];
	const timeoutMs = typeof options.timeout_ms === "number" ? options.timeout_ms : undefined;
	if (timeoutMs !== undefined) facts.push(formatTimeoutFact(timeoutMs));
	if (typeof options.max_output_tokens === "number") {
		facts.push(`(tokens ${String(options.max_output_tokens)})`);
	}
	if (typeof options.target === "string" && options.target !== "local") {
		facts.push(`(${options.target})`);
	}
	return facts.join(" ");
}

export function parseCallArgs(raw: unknown): Record<string, unknown> | undefined {
	if (isRecord(raw)) return raw;
	if (typeof raw !== "string") return undefined;
	const text = raw.trim();
	if (text === "") return undefined;
	if (text.startsWith("{")) {
		try {
			const parsed = JSON.parse(text);
			if (isRecord(parsed)) return parsed;
		} catch {
			const record: Record<string, unknown> = {};
			const extractString = (key: string) => {
				const regex = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`);
				const match = regex.exec(text);
				if (match?.[1]) {
					record[key] = match[1].replace(/\\"/g, '"');
				}
			};
			const extractNumber = (key: string) => {
				const regex = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
				const match = regex.exec(text);
				if (match?.[1]) {
					record[key] = Number(match[1]);
				}
			};

			extractString("path");
			extractString("file_path");
			extractString("command");
			extractString("pattern");
			extractString("glob");
			extractString("query");
			extractString("url");
			extractString("id");
			extractString("agent");
			extractString("topic");
			extractString("source");
			extractNumber("offset");
			extractNumber("limit");

			if (Object.keys(record).length > 0) return record;
		}
	}
	return undefined;
}

export function extractSummaryArg(toolName: string, args: unknown): string {
	if (toolName === "codemode") {
		return extractCodemodeHeaderFacts(args);
	}
	const parsed = parseCallArgs(args);
	if (!parsed) return "";
	for (const key of [
		"command",
		"query",
		"queries",
		"url",
		"urls",
		"source",
		"claim",
		"id",
		"search_id",
		"topic",
		"path",
		"file_path",
		"pattern",
		"agent",
	]) {
		const val = parsed[key];
		if (typeof val === "string" && val.trim() !== "") {
			return stripTerminalSequences(val.trim());
		}
		if (Array.isArray(val) && val.length > 0 && typeof val[0] === "string") {
			const first = stripTerminalSequences(val[0].trim());
			return val.length > 1 ? `${first} (+${String(val.length - 1)})` : first;
		}
	}
	return "";
}

export function extractHeavyInputCommand(toolName: string, args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	if (toolName === "bash" && typeof args.command === "string") {
		return args.command.trim();
	}
	if (toolName === "python_eval" && typeof args.code === "string") {
		return args.code.trim();
	}
	if (toolName === "codemode" && typeof args.code === "string") {
		return args.code.trim();
	}
	return undefined;
}

export function extractNestedCalls(
	result: AgentToolResult<unknown> | undefined,
): readonly NestedCallRecord[] {
	if (result === undefined || !isRecord(result.details)) return [];
	const rawList = Array.isArray(result.details.calls)
		? result.details.calls
		: Array.isArray(result.details.nestedCalls)
			? result.details.nestedCalls
			: undefined;
	if (rawList === undefined) return [];
	const items: NestedCallRecord[] = [];
	for (const entry of rawList) {
		if (!isRecord(entry)) continue;
		const name =
			typeof entry.name === "string"
				? entry.name
				: typeof entry.toolName === "string"
					? entry.toolName
					: undefined;
		if (name === undefined) continue;
		const rawStatus = entry.status;
		const status =
			rawStatus === "running" ||
			rawStatus === "ok" ||
			rawStatus === "error" ||
			rawStatus === "cancelled"
				? rawStatus
				: undefined;
		const summary =
			typeof entry.args === "string" && entry.args.trim() !== ""
				? entry.args
				: typeof entry.summary === "string"
					? entry.summary
					: undefined;
		items.push({
			toolName: name,
			summary,
			status,
			isError: entry.isError === true || status === "error",
			isWarning: entry.isWarning === true || status === "cancelled",
			durationMs: typeof entry.durationMs === "number" ? entry.durationMs : undefined,
			cost: typeof entry.cost === "number" ? entry.cost : undefined,
			error: typeof entry.error === "string" ? entry.error : undefined,
		});
	}
	return items;
}

export function extractResultText(
	toolName: string,
	result: AgentToolResult<unknown>,
): {
	readonly outputText: string;
	readonly wallTimeSeconds: number | undefined;
} {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text.trim() !== "") {
			parts.push(block.text);
		}
	}
	const joined = parts.join("\n");
	if (toolName === "codemode") {
		const stripped = stripTerminalSequences(joined);
		const match = CODEMODE_SCRIPT_HEADER.exec(stripped);
		const wallTimeSeconds = match?.[1] !== undefined ? Number.parseFloat(match[1]) : undefined;
		const cleaned = joined.replace(CODEMODE_SCRIPT_HEADER, "").trim();
		return { outputText: cleaned, wallTimeSeconds };
	}
	return { outputText: joined, wallTimeSeconds: undefined };
}

export function callStatsParts(total: number, failCount: number): string[] {
	if (failCount > 0) {
		return [`${String(total - failCount)} ok`, `${String(failCount)} failed`];
	}
	return [`${String(total)} ${total === 1 ? "call" : "calls"}`];
}

export function resolveContainerStatus(params: {
	readonly isError: boolean;
	readonly isPartial: boolean;
	readonly hasChildren: boolean;
	readonly selfFailed: boolean;
}): ToolStatusKind {
	if (params.selfFailed) return "error";
	if (params.hasChildren) return "none";
	if (params.isPartial) return "running";
	return params.isError ? "error" : "ok";
}

export function toolPath(args: unknown): string {
	const parsed = parseCallArgs(args);
	if (!parsed) return "";
	const val = parsed.path ?? parsed.file_path;
	return typeof val === "string" ? val.trim() : "";
}

export function editPath(args: unknown): string {
	return toolPath(args);
}

export function numericField(value: unknown, key: string): number | undefined {
	return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

export type WritePresentation =
	| {
			readonly kind: "diff";
			readonly source: DiffSource;
			readonly added: number;
			readonly removed: number;
	  }
	| { readonly kind: "content"; readonly label: string; readonly content: string }
	| { readonly kind: "noChange" };

export function writeStoredDiff(lines: readonly unknown[]): DiffSource | undefined {
	const hunks: DiffLine[][] = [];
	let hunk: DiffLine[] = [];
	const finish = (): void => {
		if (hunk.length > 0) hunks.push(hunk);
		hunk = [];
	};
	for (const entry of lines) {
		if (!isRecord(entry)) return undefined;
		if (entry.type === "sep") {
			finish();
			continue;
		}
		if (entry.type !== "add" && entry.type !== "del" && entry.type !== "ctx") return undefined;
		if (typeof entry.content !== "string") return undefined;
		const line = entry.type === "del" ? entry.oldNum : entry.newNum;
		if (typeof line !== "number") return undefined;
		hunk.push({ kind: entry.type, line, text: entry.content });
	}
	finish();
	return hunks.length === 0
		? undefined
		: { kind: "hunks", hunks: hunks.map((lines) => ({ lines })) };
}

/** Uses only the baseline and content already stored by the write tool. */
export function writePresentation(args: unknown, details: unknown): WritePresentation | undefined {
	const view = isRecord(details) ? details[WRITE_VIEW_KEY] : undefined;
	if (!isRecord(view)) return undefined;
	if (view.kind === "noChange") return { kind: "noChange" };
	if (view.kind === "diff") {
		const stored = Array.isArray(view.lines) ? writeStoredDiff(view.lines) : undefined;
		if (stored === undefined) return undefined;
		const source = stored;
		const stats = diffStats(source);
		return stats === undefined
			? undefined
			: {
					kind: "diff",
					source,
					added: numericField(view, "added") ?? stats.added,
					removed: numericField(view, "removed") ?? stats.removed,
				};
	}
	if (view.kind !== "new" && view.kind !== "replace") return undefined;
	const content =
		typeof view.content === "string"
			? view.content
			: isRecord(args) && typeof args.content === "string"
				? args.content
				: undefined;
	if (content === undefined) return undefined;
	const lines = numericField(view, "lines") ?? content.split("\n").length;
	return {
		kind: "content",
		label:
			view.kind === "new" ? `new file (${String(lines)} lines)` : `wrote (${String(lines)} lines)`,
		content,
	};
}

/** Compact nested-row result: a one-line summary plus the status it reports. */
export interface InlinePresentation {
	readonly summary: string;
	readonly status: ToolStatusKind;
}

export function fileToolPresentation(
	toolName: string,
	args: unknown,
	details: unknown,
	isError: boolean,
): InlinePresentation | undefined {
	const path = toolPath(args);
	if (toolName === "read") {
		if (path === "") return undefined;
		const parsed = parseCallArgs(args);
		const range = formatReadLineRange(parsed?.offset, parsed?.limit);
		return { summary: `${path}${range}`, status: isError ? "error" : "ok" };
	}
	if (toolName === WRITE_TOOL_NAME) {
		const presentation = isError ? undefined : writePresentation(args, details);
		const delta =
			presentation?.kind === "diff"
				? ` (+${String(presentation.added)} -${String(presentation.removed)})`
				: presentation?.kind === "content"
					? ` (${presentation.label})`
					: presentation?.kind === "noChange"
						? " (no changes)"
						: "";
		if (path === "" && delta === "") return undefined;
		return {
			summary: `${path}${delta}`.trim(),
			status: isError ? "error" : presentation?.kind === "noChange" ? "none" : "ok",
		};
	}
	return undefined;
}

/** Pi native edit persists a unified patch plus the same change as a numbered display diff. */
export function editDiffSource(details: unknown): DiffSource | undefined {
	if (!isRecord(details)) return undefined;
	if (typeof details.patch === "string" && details.patch.trim() !== "") {
		return { kind: "unifiedPatch", text: details.patch };
	}
	if (typeof details.diff === "string" && details.diff.trim() !== "") {
		return displayDiffSource(details.diff);
	}
	return editViewSource(details[EDIT_VIEW_KEY]);
}

export function displayDiffSource(diff: string): DiffSource | undefined {
	const hunks: DiffLine[][] = [];
	let current: DiffLine[] = [];
	let pendingBreak = false;
	for (const raw of diff.split(/\r?\n/)) {
		if (raw === "") continue;
		const sign = raw.charAt(0);
		const match = /^ *(\d+)? ?(.*)$/.exec(raw.slice(1));
		const lineNumber = match?.[1];
		if (lineNumber === undefined) {
			pendingBreak = true;
			continue;
		}
		if (pendingBreak && current.length > 0) {
			hunks.push(current);
			current = [];
		}
		pendingBreak = false;
		const kind: DiffLine["kind"] = sign === "+" ? "add" : sign === "-" ? "del" : "ctx";
		current.push({ kind, line: Number(lineNumber), text: match?.[2] ?? "" });
	}
	if (current.length === 0) return undefined;
	hunks.push(current);
	return { kind: "hunks", hunks: hunks.map((lines) => ({ lines })) };
}

export function editViewSource(view: unknown): DiffSource | undefined {
	const hunks = editViewHunks(view);
	return hunks.length === 0 ? undefined : { kind: "hunks", hunks };
}

export function editViewHunks(view: unknown): readonly { readonly lines: readonly DiffLine[] }[] {
	if (!isRecord(view)) return [];
	const ops =
		view.kind === "single" && isRecord(view.op)
			? [view.op]
			: view.kind === "multi" && Array.isArray(view.ops)
				? view.ops.filter(isRecord)
				: [];
	return ops.flatMap((op) => hunksForEditOp(op));
}

export function hunksForEditOp(
	op: Record<string, unknown>,
): readonly { readonly lines: readonly DiffLine[] }[] {
	if (typeof op.oldContent !== "string" || typeof op.newContent !== "string") return [];
	const startLine = typeof op.startLine === "number" && op.startLine > 0 ? op.startLine : 1;
	return lineHunks(
		op.oldContent.replace(/\r\n/g, "\n"),
		op.newContent.replace(/\r\n/g, "\n"),
		startLine,
	);
}

export function splitFragment(text: string): readonly string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/** Line LCS of one stored before/after fragment. No file context is invented. */
export function lineHunks(
	before: string,
	after: string,
	startLine: number,
): readonly { readonly lines: readonly DiffLine[] }[] {
	const oldLines = splitFragment(before);
	const newLines = splitFragment(after);
	const oldCount = oldLines.length;
	const newCount = newLines.length;
	const lengths: number[][] = Array.from({ length: oldCount + 1 }, () =>
		Array<number>(newCount + 1).fill(0),
	);
	for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex -= 1) {
		const row = lengths[oldIndex];
		const next = lengths[oldIndex + 1];
		if (row === undefined || next === undefined) continue;
		for (let newIndex = newCount - 1; newIndex >= 0; newIndex -= 1) {
			row[newIndex] =
				oldLines[oldIndex] === newLines[newIndex]
					? (next[newIndex + 1] ?? 0) + 1
					: Math.max(next[newIndex] ?? 0, row[newIndex + 1] ?? 0);
		}
	}

	const lines: DiffLine[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	let oldLine = startLine;
	let newLine = startLine;
	while (oldIndex < oldCount || newIndex < newCount) {
		const row = lengths[oldIndex];
		const next = lengths[oldIndex + 1];
		if (oldIndex < oldCount && newIndex < newCount && oldLines[oldIndex] === newLines[newIndex]) {
			lines.push({ kind: "ctx", line: newLine, text: oldLines[oldIndex] ?? "" });
			oldIndex += 1;
			newIndex += 1;
			oldLine += 1;
			newLine += 1;
		} else if (
			newIndex < newCount &&
			(oldIndex === oldCount || (row?.[newIndex + 1] ?? 0) > (next?.[newIndex] ?? 0))
		) {
			lines.push({ kind: "add", line: newLine, text: newLines[newIndex] ?? "" });
			newIndex += 1;
			newLine += 1;
		} else {
			lines.push({ kind: "del", line: oldLine, text: oldLines[oldIndex] ?? "" });
			oldIndex += 1;
			oldLine += 1;
		}
	}
	const changed = lines.some((line) => line.kind !== "ctx");
	return changed ? [{ lines }] : [];
}

export function patchTextForCopy(details: unknown): string | undefined {
	if (isRecord(details) && typeof details.patch === "string") return details.patch;
	const hunks = editViewHunks(isRecord(details) ? details[EDIT_VIEW_KEY] : undefined);
	if (hunks.length === 0) return undefined;
	return (
		hunks
			.map((hunk) => {
				let oldStart = 0;
				let newStart = 0;
				let oldCount = 0;
				let newCount = 0;
				const body = hunk.lines.map((line) => {
					if (line.kind !== "add") {
						oldCount += 1;
						if (oldStart === 0) oldStart = line.line;
					}
					if (line.kind !== "del") {
						newCount += 1;
						if (newStart === 0) newStart = line.line;
					}
					const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
					return sign + line.text;
				});
				if (body.length === 0) return "";
				const header =
					"@@ -" +
					String(oldStart || 1) +
					"," +
					String(oldCount) +
					" +" +
					String(newStart || 1) +
					"," +
					String(newCount) +
					" @@";
				return [header, ...body].join("\n");
			})
			.filter((hunk) => hunk !== "")
			.join("\n") || undefined
	);
}

export function patchSummary(files: number, added: number, removed: number): string {
	return `modify ${files}${files === 1 ? " file" : " files"} (+${added} -${removed})`;
}

/**
 * The name-free part of a summary for tools whose call arguments read well on their own. The tool
 * name is the row's title, so repeating it here would print it twice.
 */
function formatArgumentSummary(
	toolName: string,
	parsed: Record<string, unknown>,
): string | undefined {
	const path =
		typeof parsed.path === "string"
			? parsed.path.trim()
			: typeof parsed.file_path === "string"
				? parsed.file_path.trim()
				: "";

	switch (toolName) {
		case "bash": {
			const cmd = typeof parsed.command === "string" ? parsed.command.trim() : "";
			if (!cmd) return undefined;
			return cmd.length > 70 ? `${cmd.slice(0, 67)}…` : cmd;
		}
		case "grep":
		case "find": {
			const pattern = typeof parsed.pattern === "string" ? parsed.pattern.trim() : "";
			if (!pattern) return undefined;
			const target = path && path !== "." ? ` ${path}` : "";
			return `${pattern}${target}`;
		}
		default: {
			const keyArg = extractSummaryArg(toolName, parsed);
			return keyArg ? keyArg : undefined;
		}
	}
}

/**
 * One compact nested summary for a tool call. Adopts the tool's standard collapsed
 * single-line format when recognized, degrading to undefined so callers can use
 * the default argument rendering.
 */
export function inlinePresentation(
	toolName: string,
	args: unknown,
	details: unknown,
	isError: boolean,
): InlinePresentation | undefined {
	const fileTool = fileToolPresentation(toolName, args, details, isError);
	if (fileTool !== undefined) return fileTool;

	const parsed = parseCallArgs(args);
	if (toolName === APPLY_PATCH_TOOL_NAME) {
		const facts = applyPatchFacts(details);
		if (facts !== undefined) {
			return {
				summary: patchSummary(
					new Set(facts.changedPaths).size,
					facts.addedLines,
					facts.removedLines,
				),
				status: isError ? "error" : "ok",
			};
		}
		if (parsed === undefined || typeof parsed.patch !== "string") return undefined;
		const operations = previewV4aOperations(parsed.patch, true, undefined);
		return {
			summary: patchSummary(
				new Set(operations.map((operation) => operation.path)).size,
				operations.reduce((sum, operation) => sum + operation.addedLines, 0),
				operations.reduce((sum, operation) => sum + operation.removedLines, 0),
			),
			status: isError ? "error" : "ok",
		};
	}
	if (parsed === undefined) return undefined;

	if (toolName === EDIT_TOOL_NAME) {
		const path = toolPath(parsed);
		const source = isError ? undefined : editDiffSource(details);
		const stats = source === undefined ? undefined : diffStats(source);
		if (path === "" && stats === undefined) return undefined;
		return {
			summary:
				stats === undefined
					? path
					: `${path} (+${String(stats.added)} -${String(stats.removed)})`.trim(),
			status: isError ? "error" : "ok",
		};
	}

	const baseSummary = formatArgumentSummary(toolName, parsed);
	if (baseSummary === undefined) return undefined;

	return {
		summary: baseSummary,
		status: isError ? "error" : "ok",
	};
}

/**
 * One row of the eval cell transcript: printed text, display value, nested call, the final
 * value, or the kernel's namespace report.
 */
export type EvalRow =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "display"; readonly text: string }
	| {
			readonly kind: "tool";
			readonly name: string;
			readonly args: unknown;
			readonly durationMs: number | undefined;
			readonly error: string | undefined;
	  }
	| { readonly kind: "result"; readonly text: string }
	| { readonly kind: "state"; readonly text: string };

export interface EvalFacts {
	readonly rows: readonly EvalRow[];
	readonly error: string | undefined;
}

/** Reads only the persisted `pi-ext-tools-eval` details; other shapes degrade to plain output. */
export function pythonEvalFacts(details: unknown): EvalFacts | undefined {
	if (!isRecord(details) || details.format !== PYTHON_EVAL_DETAILS_FORMAT) return undefined;
	const rawRows = Array.isArray(details.rows) ? details.rows : [];
	const rows: EvalRow[] = [];
	for (const entry of rawRows) {
		if (!isRecord(entry)) continue;
		if (entry.kind === "text" && typeof entry.text === "string") {
			rows.push({ kind: "text", text: entry.text });
		} else if (entry.kind === "display" && typeof entry.text === "string") {
			rows.push({ kind: "display", text: entry.text });
		} else if (entry.kind === "result" && typeof entry.text === "string") {
			rows.push({ kind: "result", text: entry.text });
		} else if (entry.kind === "state" && typeof entry.text === "string") {
			rows.push({ kind: "state", text: entry.text });
		} else if (entry.kind === "tool" && isRecord(entry.trace)) {
			const trace = entry.trace;
			if (typeof trace.name !== "string") continue;
			rows.push({
				kind: "tool",
				name: trace.name,
				args: trace.args,
				durationMs: typeof trace.durationMs === "number" ? trace.durationMs : undefined,
				error: typeof trace.error === "string" ? trace.error : undefined,
			});
		}
	}
	return {
		rows,
		error: typeof details.error === "string" ? details.error : undefined,
	};
}
