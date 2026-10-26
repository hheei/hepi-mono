import { Script } from "node:vm";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

export const CODEMODE_TOOL_NAME = "codemode";

/**
 * Mirrors the wrapper pi-codemode evaluates in its QuickJS runtime:
 * `(async (tools, console) => {${code}\n})`. The prefix shares the first line with the script so
 * reported line numbers match the source as the model wrote it, including a first-line
 * `// @options:` comment, which stays a plain comment either way.
 */
export const CODEMODE_WRAPPER_PREFIX = "(async (tools, console) => {";

const CODEMODE_WRAPPER_SUFFIX = "\n})";
const CODEMODE_FILENAME = "codemode.js";
const MAX_SOURCE_LINE_CHARS = 160;

export interface CodemodeSyntaxDiagnostics {
	readonly message: string;
	readonly line?: number;
	readonly sourceLine?: string;
	readonly caretStart?: number;
	readonly caretEnd?: number;
}

export function wrapCodemodeSource(code: string): string {
	return `${CODEMODE_WRAPPER_PREFIX}${code}${CODEMODE_WRAPPER_SUFFIX}`;
}

/** Reads the line, source text, and caret span that V8 puts in a compile error's stack. */
export function parseCodemodeSyntaxDiagnostics(error: SyntaxError): CodemodeSyntaxDiagnostics {
	const message = error.message;
	const stackLines = (error.stack ?? "").split("\n");
	const headerIndex = stackLines.findIndex((line) => line.startsWith(`${CODEMODE_FILENAME}:`));
	const header = headerIndex === -1 ? undefined : stackLines[headerIndex];
	if (header === undefined) return { message };
	const line = Number(header.slice(CODEMODE_FILENAME.length + 1));
	if (!Number.isSafeInteger(line) || line <= 0) return { message };
	const sourceLine = stackLines[headerIndex + 1];
	const caretLine = stackLines[headerIndex + 2] ?? "";
	const caretStart = caretLine.indexOf("^");
	const caretEnd = caretStart === -1 ? -1 : caretLine.lastIndexOf("^");
	return {
		message,
		line,
		...(sourceLine === undefined ? {} : { sourceLine }),
		...(caretStart === -1 ? {} : { caretStart, caretEnd }),
	};
}

interface ClippedLine {
	readonly text: string;
	readonly caretStart: number;
	readonly caretEnd: number;
}

function clipSourceLine(line: string, caretStart: number, caretEnd: number): ClippedLine {
	if (line.length <= MAX_SOURCE_LINE_CHARS) return { text: line, caretStart, caretEnd };
	const windowChars = MAX_SOURCE_LINE_CHARS - 2;
	const start = Math.min(
		Math.max(0, caretStart - Math.floor(windowChars / 2)),
		Math.max(0, line.length - windowChars),
	);
	const end = start + windowChars;
	const lead = start > 0 ? 1 : 0;
	return {
		text: `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`,
		caretStart: caretStart - start + lead,
		caretEnd: Math.min(caretEnd - start + lead, windowChars + lead - 1),
	};
}

export function formatCodemodeSyntaxError(error: SyntaxError, code: string): string {
	const { message, line, sourceLine, caretStart, caretEnd } = parseCodemodeSyntaxDiagnostics(error);
	const body: string[] = [];
	if (
		line !== undefined &&
		line <= code.split("\n").length &&
		sourceLine !== undefined &&
		caretStart !== undefined &&
		caretEnd !== undefined
	) {
		const prefixLength = line === 1 ? CODEMODE_WRAPPER_PREFIX.length : 0;
		const clipped = clipSourceLine(
			sourceLine.slice(prefixLength),
			caretStart - prefixLength,
			caretEnd - prefixLength,
		);
		const gutter = `  ${line} | `;
		const carets = "^".repeat(Math.max(1, clipped.caretEnd - clipped.caretStart + 1));
		body.push(gutter + clipped.text);
		body.push(
			`${" ".repeat(gutter.length - 2)}| ${" ".repeat(Math.max(0, clipped.caretStart))}${carets}`,
		);
	} else if (line !== undefined) {
		body.push(`  (end of script, line ${line})`);
	}

	return [`SyntaxError: ${message}`, ...(body.length > 0 ? ["", ...body] : [])].join("\n");
}

/**
 * Compiles the script with the same wrapper the QuickJS runtime uses and returns a repair message
 * for syntax errors. Returns undefined when the script compiles, or when the failure is not a
 * SyntaxError: a QuickJS-only limit such as parser recursion depth must stay with the tool.
 */
export function checkCodemodeSyntax(code: string): string | undefined {
	try {
		new Script(wrapCodemodeSource(code), { filename: CODEMODE_FILENAME });
		return undefined;
	} catch (error) {
		return error instanceof SyntaxError ? formatCodemodeSyntaxError(error, code) : undefined;
	}
}

/**
 * Blocks `codemode` calls whose script cannot compile, so the model gets the offending line and
 * caret instead of a bare QuickJS message with a column offset into a very long line.
 *
 * Never sets `terminate`: a typo must not end the turn. Nested calls are left alone because the
 * parent script already reports their failures. Blocking here hides the call from later
 * `tool_call` handlers, so a handler that rewrites codemode input has to be registered first.
 */
export function createCodemodeSyntaxGuard(): (
	event: ToolCallEvent,
) => ToolCallEventResult | undefined {
	return (event) => {
		if (event.toolName !== CODEMODE_TOOL_NAME || event.parentToolCallId !== undefined) {
			return undefined;
		}
		const code = event.input.code;
		if (typeof code !== "string" || code.trim() === "") return undefined;
		const reason = checkCodemodeSyntax(code);
		return reason === undefined ? undefined : { block: true, reason };
	};
}
