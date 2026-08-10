import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { inferFffGrepMode } from "./fff/extension-common.js";
import type { GrepMatch } from "./fff/fff.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { withToolFrame } from "./pretty/frame.js";
import { ToolTraceController } from "./pretty/trace.js";
import { grepCollapsedFooter, renderGrepResult } from "./search-renderer.js";

const OWNER = "@hheei/pi-ext-tools";
const OUTPUT_PREFIX = "output://";
const ARTIFACT_PREFIX = "artifact://";
const DEFAULT_LIMIT = 100;
const MAX_ROWS = 2_000;
const MAX_BYTES = 50 * 1024;
const MAX_MATCHES_PER_FILE = 25;
const MAX_DISPLAY_MATCHES = 200;
const MAX_LINE_CHARS = 80;

const schema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(
		Type.String({ description: "Directory or file to search (default: current directory)" }),
	),
	glob: Type.Optional(
		Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" }),
	),
	ignoreCase: Type.Optional(
		Type.Boolean({ description: "Case-insensitive search (default: false)" }),
	),
	literal: Type.Optional(
		Type.Boolean({
			description: "Treat pattern as literal string instead of regex (default: false)",
		}),
	),
	context: Type.Optional(
		Type.Number({
			description: "Number of lines to show before and after each match (default: 0)",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum number of matches to return (default: 100)" }),
	),
});

type GrepParams = {
	readonly pattern: string;
	readonly path?: string;
	readonly glob?: string;
	readonly ignoreCase?: boolean;
	readonly literal?: boolean;
	readonly context?: number;
	readonly limit?: number;
};

export type GrepSubmatch = {
	readonly start: number;
	readonly end: number;
	readonly text: string;
};

export type GrepEvent =
	| {
			readonly type: "match";
			readonly path: string;
			readonly lines: string;
			readonly lineNumber: number;
			readonly absoluteOffset?: number;
			readonly submatches: readonly GrepSubmatch[];
			readonly approximate?: boolean;
	  }
	| {
			readonly type: "context";
			readonly path: string;
			readonly lines: string;
			readonly lineNumber: number;
			readonly absoluteOffset?: number;
	  };

export type GrepDisplayLine =
	| { readonly type: "text" | "path" | "omission"; readonly text: string }
	| {
			readonly type: "match";
			readonly lineNumber: number;
			readonly text: string;
			readonly source: string;
			readonly visibleStart: number;
			readonly visibleEnd: number;
			readonly truncatedLeft: boolean;
			readonly truncatedRight: boolean;
			readonly submatches: readonly GrepSubmatch[];
			readonly approximate?: boolean;
	  }
	| {
			readonly type: "context";
			readonly lineNumber: number;
			readonly text: string;
			readonly source: string;
			readonly visibleStart: number;
			readonly visibleEnd: number;
			readonly truncatedLeft: boolean;
			readonly truncatedRight: boolean;
	  };

export type GrepToolDetails = {
	readonly format: "canonical-grep";
	readonly engine: "fff" | "rg";
	readonly events: readonly GrepEvent[];
	readonly display: readonly GrepDisplayLine[];
	readonly totalMatched: number;
	readonly totalFiles: number;
	readonly durationMs: number;
	readonly cap: {
		readonly rows: number;
		readonly bytes: number;
		readonly maxRows: number;
		readonly maxBytes: number;
		readonly truncated: boolean;
	};
	readonly recovery: { readonly output: string };
	readonly fff?: { readonly itemCount: number };
};

type CanonicalResult = {
	readonly events: readonly GrepEvent[];
	readonly totalMatched: number;
	readonly cap: GrepToolDetails["cap"];
};

type FullOutput = {
	readonly text: string;
	readonly eventLines: ReadonlyMap<GrepEvent, number>;
};

function abortIfNeeded(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function normalizedLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(Math.floor(limit ?? DEFAULT_LIMIT), MAX_ROWS));
}

function normalizedContext(context: number | undefined): number {
	return Math.max(0, Math.floor(context ?? 0));
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function textAt(value: unknown): string | undefined {
	const record = object(value);
	return typeof record?.text === "string" ? record.text : undefined;
}

function numberAt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function rgEvent(value: unknown, fallbackPath: string): GrepEvent | undefined {
	const event = object(value);
	const type = event?.type;
	if (type !== "match" && type !== "context") return undefined;
	const data = object(event?.data);
	const rawPath = textAt(data?.path);
	const path = rawPath === undefined || rawPath === "<stdin>" ? fallbackPath : rawPath;
	const lines = textAt(data?.lines);
	const lineNumber = numberAt(data?.line_number);
	if (lines === undefined || lineNumber === undefined || lineNumber < 1) return undefined;
	const absoluteOffset = numberAt(data?.absolute_offset);
	if (type === "context") {
		return {
			type,
			path,
			lines: lines.replace(/\n$/, ""),
			lineNumber,
			...(absoluteOffset === undefined ? {} : { absoluteOffset }),
		};
	}
	const submatches = Array.isArray(data?.submatches)
		? data.submatches.flatMap((candidate) => {
				const item = object(candidate);
				const start = numberAt(item?.start);
				const end = numberAt(item?.end);
				const text = textAt(item?.match);
				return start === undefined || end === undefined || end < start || text === undefined
					? []
					: [{ start, end, text }];
			})
		: [];
	return {
		type,
		path,
		lines: lines.replace(/\n$/, ""),
		lineNumber,
		...(absoluteOffset === undefined ? {} : { absoluteOffset }),
		submatches,
	};
}

function capEvents(events: readonly GrepEvent[], limit: number, context: number): CanonicalResult {
	const selectedMatches: GrepEvent[] = [];
	for (const event of events) {
		if (event.type === "match" && selectedMatches.length < limit) selectedMatches.push(event);
	}
	const matchLines = new Map<string, number[]>();
	for (const event of selectedMatches) {
		const lines = matchLines.get(event.path) ?? [];
		lines.push(event.lineNumber);
		matchLines.set(event.path, lines);
	}
	const relevant = events.filter((event) => {
		if (event.type === "match") return selectedMatches.includes(event);
		return (matchLines.get(event.path) ?? []).some(
			(lineNumber) => Math.abs(lineNumber - event.lineNumber) <= context,
		);
	});
	const capped: GrepEvent[] = [];
	let bytes = 0;
	for (const event of relevant) {
		const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
		if (capped.length >= MAX_ROWS || bytes + eventBytes > MAX_BYTES) break;
		capped.push(event);
		bytes += eventBytes;
	}
	return {
		events: capped,
		totalMatched: capped.filter((event) => event.type === "match").length,
		cap: {
			rows: capped.length,
			bytes,
			maxRows: MAX_ROWS,
			maxBytes: MAX_BYTES,
			truncated: capped.length < relevant.length,
		},
	};
}

function rgOrder(events: readonly GrepEvent[]): GrepEvent[] {
	const groups = new Map<string, GrepEvent[]>();
	for (const event of events) {
		const group = groups.get(event.path);
		if (group) group.push(event);
		else groups.set(event.path, [event]);
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([, group]) => group);
}

function fffEvents(items: readonly GrepMatch[], approximate = false): GrepEvent[] {
	const files = new Map<string, Map<number, GrepEvent>>();
	for (const item of items) {
		const file = files.get(item.relativePath) ?? new Map<number, GrepEvent>();
		files.set(item.relativePath, file);
		for (const [index, lines] of (item.contextBefore ?? []).entries()) {
			const lineNumber = item.lineNumber - (item.contextBefore?.length ?? 0) + index;
			if (!file.has(lineNumber))
				file.set(lineNumber, { type: "context", path: item.relativePath, lines, lineNumber });
		}
		file.set(item.lineNumber, {
			type: "match",
			path: item.relativePath,
			lines: item.lineContent,
			lineNumber: item.lineNumber,
			absoluteOffset: item.byteOffset,
			submatches: (item.matchRanges ?? []).map(([start, end]) => ({
				start,
				end,
				text: item.lineContent.slice(start, end),
			})),
			...(approximate ? { approximate: true } : {}),
		});
		for (const [index, lines] of (item.contextAfter ?? []).entries()) {
			const lineNumber = item.lineNumber + index + 1;
			if (!file.has(lineNumber))
				file.set(lineNumber, { type: "context", path: item.relativePath, lines, lineNumber });
		}
	}
	return [...files.values()].flatMap((file) =>
		[...file.values()].sort((left, right) => left.lineNumber - right.lineNumber),
	);
}

function fullOutput(events: readonly GrepEvent[]): FullOutput {
	const lines: string[] = [];
	const eventLines = new Map<GrepEvent, number>();
	const groups = new Map<string, GrepEvent[]>();
	for (const event of events) {
		const group = groups.get(event.path);
		if (group) group.push(event);
		else groups.set(event.path, [event]);
	}
	for (const [index, [path, group]] of [...groups.entries()].entries()) {
		if (index > 0) lines.push("");
		lines.push(path);
		for (const event of group) {
			lines.push(`${event.lineNumber}${event.type === "match" ? ":" : "-"}${event.lines}`);
			eventLines.set(event, lines.length);
		}
	}
	return {
		text: lines.length === 0 ? "No matches found" : lines.join("\n"),
		eventLines,
	};
}

function compactPath(path: string): string {
	if (Array.from(path).length <= MAX_LINE_CHARS) return path;
	const parts = path.split("/");
	let tail = parts.pop() ?? path;
	while (parts.length > 0 && Array.from(`.../${parts.at(-1)}/${tail}`).length <= MAX_LINE_CHARS) {
		tail = `${parts.pop()}/${tail}`;
	}
	return `.../${tail}`;
}

function charIndexAtByte(text: string, byteOffset: number): number | undefined {
	let bytes = 0;
	let index = 0;
	if (byteOffset === 0) return 0;
	for (const character of text) {
		bytes += Buffer.byteLength(character, "utf8");
		index += 1;
		if (bytes === byteOffset) return index;
		if (bytes > byteOffset) return undefined;
	}
	return undefined;
}

function compactText(
	text: string,
	focusByteOffset?: number,
): {
	text: string;
	visibleStart: number;
	visibleEnd: number;
	truncatedLeft: boolean;
	truncatedRight: boolean;
} {
	const leading = text.length - text.trimStart().length;
	const trimmed = text.trim();
	const characters = Array.from(trimmed);
	const leadingBytes = Buffer.byteLength(text.slice(0, leading), "utf8");
	const focus =
		focusByteOffset === undefined
			? undefined
			: charIndexAtByte(trimmed, focusByteOffset - leadingBytes);
	const start =
		characters.length <= MAX_LINE_CHARS || focus === undefined
			? 0
			: Math.max(
					0,
					Math.min(focus - Math.floor(MAX_LINE_CHARS / 2), characters.length - MAX_LINE_CHARS),
				);
	const visible = characters.slice(start, start + MAX_LINE_CHARS).join("");
	const visibleStart =
		leadingBytes + Buffer.byteLength(characters.slice(0, start).join(""), "utf8");
	return {
		text: visible,
		visibleStart,
		visibleEnd: visibleStart + Buffer.byteLength(visible, "utf8"),
		truncatedLeft: start > 0,
		truncatedRight: start + MAX_LINE_CHARS < characters.length,
	};
}

function displayEvent(event: GrepEvent): GrepDisplayLine {
	const compact = compactText(
		event.lines,
		event.type === "match" ? event.submatches[0]?.start : undefined,
	);
	if (event.type === "context")
		return {
			type: "context",
			lineNumber: event.lineNumber,
			text: compact.text,
			source: event.lines,
			visibleStart: compact.visibleStart,
			visibleEnd: compact.visibleEnd,
			truncatedLeft: compact.truncatedLeft,
			truncatedRight: compact.truncatedRight,
		};
	return {
		type: "match",
		lineNumber: event.lineNumber,
		text: compact.text,
		source: event.lines,
		visibleStart: compact.visibleStart,
		visibleEnd: compact.visibleEnd,
		truncatedLeft: compact.truncatedLeft,
		truncatedRight: compact.truncatedRight,
		submatches: event.submatches,
		...(event.approximate ? { approximate: true } : {}),
	};
}

function rangeFor(
	events: readonly GrepEvent[],
	full: FullOutput,
): { start: number; end: number } | undefined {
	const lines = events.flatMap((event) => {
		const line = full.eventLines.get(event);
		return line === undefined ? [] : [line];
	});
	if (lines.length === 0) return undefined;
	return { start: Math.min(...lines), end: Math.max(...lines) };
}

function compactOutput(
	canonical: CanonicalResult,
	full: FullOutput,
	output: string,
	context: number,
): readonly GrepDisplayLine[] {
	if (canonical.totalMatched === 0) return [{ type: "text", text: "No matches found" }];
	const fuzzy = canonical.events.some((event) => event.type === "match" && event.approximate);
	const files = new Set(canonical.events.map((event) => event.path)).size;
	const display: GrepDisplayLine[] = [
		{
			type: "text",
			text: `${canonical.totalMatched}${fuzzy ? " fuzzy" : ""} matches in ${files} files`,
		},
	];
	const groups = new Map<string, GrepEvent[]>();
	for (const event of canonical.events) {
		const group = groups.get(event.path);
		if (group) group.push(event);
		else groups.set(event.path, [event]);
	}
	let shown = 0;
	const entries = [...groups.entries()];
	for (let fileIndex = 0; fileIndex < entries.length; fileIndex += 1) {
		const [path, events] = entries[fileIndex] ?? [];
		if (path === undefined || events === undefined) continue;
		const matches = events.filter((event) => event.type === "match");
		if (shown >= MAX_DISPLAY_MATCHES) {
			const omitted = entries.slice(fileIndex).flatMap(([, remaining]) => remaining);
			const range = rangeFor(omitted, full);
			const files = entries.length - fileIndex;
			if (range)
				display.push({
					type: "omission",
					text: `+${files} files omitted -> ${output}:${range.start}-${range.end}`,
				});
			break;
		}
		const allowed = Math.min(MAX_MATCHES_PER_FILE, MAX_DISPLAY_MATCHES - shown);
		const visibleMatches = matches.slice(0, allowed);
		if (visibleMatches.length === 0) continue;
		display.push({ type: "path", text: compactPath(path) });
		const matchSet = new Set(visibleMatches);
		const visibleLines = new Set(
			visibleMatches.flatMap((match) =>
				events
					.filter((event) => Math.abs(event.lineNumber - match.lineNumber) <= context)
					.map((event) => event.lineNumber),
			),
		);
		for (const event of events) {
			if (event.type === "match" ? matchSet.has(event) : visibleLines.has(event.lineNumber))
				display.push(displayEvent(event));
		}
		shown += visibleMatches.length;
		if (matches.length > visibleMatches.length) {
			const omitted = events.filter((event) => event.type === "match" && !matchSet.has(event));
			const range = rangeFor(omitted, full);
			if (range)
				display.push({
					type: "omission",
					text: `+${matches.length - visibleMatches.length} matches omitted -> ${output}:${range.start}-${range.end}`,
				});
		}
	}
	return display;
}

function displayText(display: readonly GrepDisplayLine[]): string {
	return display
		.map((line) =>
			line.type === "match"
				? `${line.lineNumber}:${line.text}`
				: line.type === "context"
					? `${line.lineNumber}-${line.text}`
					: line.text,
		)
		.join("\n");
}

function worktreeRoot(cwd: string): Promise<boolean> {
	return new Promise((resolveRoot) => {
		const child = spawn("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const output: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
		child.once("error", () => resolveRoot(false));
		child.once("close", (code) =>
			resolveRoot(
				code === 0 && resolve(Buffer.concat(output).toString("utf8").trim()) === resolve(cwd),
			),
		);
	});
}

async function runRg(
	params: GrepParams,
	cwd: string,
	outputText: string | undefined,
	signal: AbortSignal | undefined,
): Promise<CanonicalResult> {
	const context = normalizedContext(params.context);
	// ponytail: require rg on PATH; add Pi's pinned resolver only if extension must run without system rg.
	const args = ["--json", "--line-number", "--color=never", "--hidden"];
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.glob) args.push("--glob", params.glob);
	if (context > 0) args.push("--context", String(context));
	args.push("--", params.pattern);
	if (outputText === undefined) args.push(params.path ?? ".");
	const stdout = await new Promise<string>((resolveOutput, reject) => {
		abortIfNeeded(signal);
		const child = spawn("rg", args, {
			cwd,
			stdio: [outputText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		const output: Buffer[] = [];
		const errorOutput: Buffer[] = [];
		let aborted = false;
		const onAbort = () => {
			aborted = true;
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => errorOutput.push(chunk));
		child.once("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			reject(new Error(`Failed to run ripgrep: ${error.message}`));
		});
		child.once("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (aborted) return reject(new Error("Operation aborted"));
			if (code !== 0 && code !== 1) {
				const message = Buffer.concat(errorOutput).toString("utf8").trim();
				return reject(new Error(message || `ripgrep exited with code ${code}`));
			}
			resolveOutput(Buffer.concat(output).toString("utf8"));
		});
		if (outputText !== undefined) child.stdin?.end(outputText);
	});
	abortIfNeeded(signal);
	const fallbackPath =
		outputText === undefined ? (params.path ?? ".") : (params.path ?? "output://unknown");
	const events = stdout
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const event = rgEvent(JSON.parse(line) as unknown, fallbackPath);
				return event === undefined ? [] : [event];
			} catch {
				return [];
			}
		});
	return capEvents(rgOrder(events), normalizedLimit(params.limit), context);
}

async function useFff(params: GrepParams, cwd: string, state: FffRuntimeState): Promise<boolean> {
	return (
		state.getSettings().grepEnhancement &&
		state.getRuntime() !== undefined &&
		params.path === undefined &&
		params.glob === undefined &&
		params.ignoreCase !== true &&
		worktreeRoot(cwd)
	);
}

export function registerGrepTool(
	pi: ExtensionAPI,
	state: FffRuntimeState,
	trace = new ToolTraceController(),
): void {
	const tool = {
		name: "grep",
		label: "grep",
		description: "Search file contents with ripgrep or FFF when its exact grep contract applies.",
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: schema,
		renderResult: renderGrepResult,
		async execute(
			_toolCallId: string,
			params: GrepParams,
			signal: AbortSignal | undefined,
			_onUpdate: undefined,
			context: { cwd: string },
		) {
			const startedAt = performance.now();
			abortIfNeeded(signal);
			if (params.path?.startsWith(ARTIFACT_PREFIX))
				throw new Error("artifact:// URLs are no longer supported; use output:// URLs.");
			const outputs = state.getOutputs();
			const outputText =
				params.path?.startsWith(OUTPUT_PREFIX) === true ? outputs?.read(params.path) : undefined;
			if (params.path?.startsWith(OUTPUT_PREFIX) && outputText === undefined)
				throw new Error("Unknown output URL or unavailable output registry.");
			let engine: GrepToolDetails["engine"] = "rg";
			let canonical: CanonicalResult;
			let fff: GrepToolDetails["fff"] | undefined;
			if (outputText === undefined && (await useFff(params, context.cwd, state))) {
				const runtime = state.getRuntime();
				if (runtime === undefined) throw new Error("FFF runtime became unavailable.");
				const result = await runtime.grepSearch({
					pattern: params.pattern,
					mode: inferFffGrepMode(params.literal, params.pattern),
					caseSensitive: true,
					beforeContext: normalizedContext(params.context),
					afterContext: normalizedContext(params.context),
					limit: normalizedLimit(params.limit),
					fuzzyFallbackOnly: true,
				});
				abortIfNeeded(signal);
				if (result.isOk() && result.value.regexFallbackError !== undefined) {
					const error = new Error(`FFF regex error: ${result.value.regexFallbackError}`);
					Object.assign(error, { regexFallbackError: result.value.regexFallbackError });
					throw error;
				}
				if (result.isOk()) {
					engine = "fff";
					canonical = capEvents(
						fffEvents(result.value.items, result.value.approximate === "fuzzy"),
						normalizedLimit(params.limit),
						normalizedContext(params.context),
					);
					fff = { itemCount: result.value.items.length };
				} else canonical = await runRg(params, context.cwd, undefined, signal);
			} else canonical = await runRg(params, context.cwd, outputText, signal);
			abortIfNeeded(signal);
			if (outputs === undefined) throw new Error("Output registry is unavailable.");
			const full = fullOutput(canonical.events);
			const recoveryOutput = outputs.create(full.text);
			const display = compactOutput(
				canonical,
				full,
				recoveryOutput,
				normalizedContext(params.context),
			);
			return {
				content: [{ type: "text" as const, text: displayText(display) }],
				details: {
					format: "canonical-grep" as const,
					engine,
					events: canonical.events,
					display,
					totalMatched: canonical.totalMatched,
					totalFiles: new Set(canonical.events.map((event) => event.path)).size,
					durationMs: Math.round(performance.now() - startedAt),
					cap: canonical.cap,
					recovery: { output: recoveryOutput },
					...(fff === undefined ? {} : { fff }),
				} satisfies GrepToolDetails,
			};
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "grep",
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		withToolFrame(tool, trace, grepCollapsedFooter),
	);
}
