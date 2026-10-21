import { type AgentToolResult, formatReadLineRange } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { type DiffLine, type DiffSource, diffStats } from "./diff-view.js";
import type { ToolStatusKind } from "./tool-view.js";

export const EDIT_TOOL_NAME = "edit";
export const WRITE_TOOL_NAME = "write";
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

	const firstLine = (val: unknown): string => {
		if (typeof val !== "string" || val.trim() === "") return "";
		const clean = stripTerminalSequences(val.trim());
		return clean.split("\n")[0]?.trim() ?? clean;
	};

	switch (toolName) {
		case "bash":
		case "bg_bash_spawn":
			return firstLine(parsed.command);
		case "read":
		case "edit":
		case "write": {
			const path =
				typeof parsed.path === "string"
					? parsed.path.trim()
					: typeof parsed.file_path === "string"
						? parsed.file_path.trim()
						: "";
			return stripTerminalSequences(path);
		}
		case "grep":
		case "find": {
			const pattern = typeof parsed.pattern === "string" ? parsed.pattern.trim() : "";
			const path = typeof parsed.path === "string" ? parsed.path.trim() : "";
			if (!pattern) return path ? stripTerminalSequences(path) : "";
			const target = path && path !== "." ? ` ${path}` : "";
			return `${pattern}${target}`;
		}
		case "python_eval":
			return firstLine(parsed.code);
		case "bg_bash_get":
		case "bg_bash_stop":
		case "agent_send":
		case "agent_get":
		case "agent_stop":
			return typeof parsed.id === "string" ? parsed.id.trim() : "";
		case "agent_spawn": {
			const agent = typeof parsed.agent === "string" ? parsed.agent.trim() : "";
			const task = firstLine(parsed.task);
			if (agent && task) return `${agent}: ${task}`;
			return agent || task;
		}
		case "tool_search":
			return typeof parsed.query === "string" ? parsed.query.trim() : "";
		default:
			return "";
	}
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

/** Compact nested-row result: a one-line summary plus the status it reports. */
export interface InlinePresentation {
	readonly summary: string;
	readonly status: ToolStatusKind;
}

export function fileToolPresentation(
	toolName: string,
	args: unknown,
	_details: unknown,
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
		return path === "" ? undefined : { summary: path, status: isError ? "error" : "ok" };
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
	return undefined;
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
