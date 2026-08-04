import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

type GrepRenderArgs = {
	readonly pattern: string;
	readonly path?: string | undefined;
	readonly timeout?: number | undefined;
};

type FindRenderArgs = {
	readonly pattern: string;
	readonly limit?: number | undefined;
};

type RenderContext = {
	readonly isError: boolean;
	readonly lastComponent: Component | undefined;
};

const GREP_SUMMARY = /^(\d+) matches in (\d+) files:$/;
const GREP_FILE_HEADER = /^> (.+) \((\d+) matches\):$/;
const GREP_MATCH_LINE = /^\s*(\d+):(.*)$/;
const GREP_TRUNCATION = /^\.\.\. \((\d+) more lines, ctrl\+o to expand\)$/i;
const GREP_NO_MATCHES = /^(?:No files matched\b.*|No matches found\.?)$/i;
const FIND_SUMMARY = /^\d+\/\d+ matches$/;
const FIND_CANDIDATE = /^\d+\. (.+) \(([^)]+)\)(?: - (.+))?$/;
const FIND_CURSOR = /^cursor:\s+/;
const MAX_COLLAPSED_GREP_CONTENT_LINES = 14;
const DEFAULT_GREP_TIMEOUT_SECONDS = 30;

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => ("text" in part ? part.text : ""))
		.join("\n");
}

function requestedGrepLimit(result: AgentToolResult<unknown>): number | undefined {
	if (typeof result.details !== "object" || result.details === null) return undefined;
	const requestedLimit = Reflect.get(result.details, "requestedLimit");
	return typeof requestedLimit === "number" ? requestedLimit : undefined;
}

function renderGrepText(text: string, theme: Theme, limit: number | undefined): string {
	const lines = text.split("\n");
	const lineWidth = String(
		lines.reduce((max, line) => {
			const match = line.match(GREP_MATCH_LINE);
			return match ? Math.max(max, Number(match[1])) : max;
		}, 1),
	).length;
	const rendered = lines
		.map((line) => {
			if (GREP_NO_MATCHES.test(line)) return theme.fg("warning", line);
			const truncation = line.match(GREP_TRUNCATION);
			if (truncation)
				return theme.fg("dim", `... (${truncation[1] ?? "0"} earlier lines, ^o to expand)`);
			const summary = line.match(GREP_SUMMARY);
			if (summary) {
				const actualMatches = Number(summary[1] ?? "0");
				const shownMatches = Math.min(limit ?? actualMatches, actualMatches);
				return `${theme.fg("mdCode", `${shownMatches}/${actualMatches}`)} matches in ${theme.fg("success", summary[2] ?? "0")} files:`;
			}
			const fileHeader = line.match(GREP_FILE_HEADER);
			if (fileHeader)
				return `${theme.fg("dim", fileHeader[1] ?? "")} (${theme.fg("success", fileHeader[2] ?? "0")} matches)`;
			const match = line.match(GREP_MATCH_LINE);
			if (!match) return line;
			const lineNumber = match[1] ?? "";
			const content = (match[2] ?? "").replace(/^ /, "");
			return `${theme.fg("dim", lineNumber.padStart(lineWidth, " "))}${theme.fg("dim", ":")}  ${content}`;
		})
		.join("\n");
	return lines.some((line) => GREP_SUMMARY.test(line) || GREP_NO_MATCHES.test(line))
		? `\n${rendered}`
		: rendered;
}

function collapseGrepText(text: string, expanded: boolean): string {
	const lines = text.split("\n");
	if (expanded || lines.length <= MAX_COLLAPSED_GREP_CONTENT_LINES) return text;
	const visibleLineCount = MAX_COLLAPSED_GREP_CONTENT_LINES - 1;
	return [
		...lines.slice(0, visibleLineCount),
		`... (${lines.length - visibleLineCount} more lines, ctrl+o to expand)`,
	].join("\n");
}

export function renderGrepCall(
	args: GrepRenderArgs,
	theme: Theme,
	context: Pick<RenderContext, "lastComponent">,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const scope = args.path ? ` in ${theme.fg("dim", args.path)}` : "";
	const timeout = theme.fg("dim", ` (timeout ${args.timeout ?? DEFAULT_GREP_TIMEOUT_SECONDS}s)`);
	text.setText(
		`${theme.fg("accent", "grep")} ${theme.fg("mdCode", `/${args.pattern}/`)}${scope}${timeout}`,
	);
	return text;
}

export function renderGrepResult(
	result: AgentToolResult<unknown>,
	options: { readonly expanded?: boolean },
	theme: Theme,
	context: RenderContext,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const content = resultText(result).replace(/(?:\r?\n)+$/, "");
	text.setText(
		context.isError
			? theme.fg("error", content)
			: renderGrepText(
					collapseGrepText(content, options.expanded === true),
					theme,
					requestedGrepLimit(result),
				),
	);
	return text;
}

function findTotalMatched(result: AgentToolResult<unknown>): number | undefined {
	if (typeof result.details !== "object" || result.details === null) return undefined;
	const totalMatched = Reflect.get(result.details, "totalMatched");
	return typeof totalMatched === "number" ? totalMatched : undefined;
}

function findTag(reason: string): string {
	return reason
		.split("_")
		.filter((part) => part.length > 0)
		.map((part) => part[0]?.toUpperCase() ?? "")
		.join("");
}

export function renderFindCall(
	args: FindRenderArgs,
	theme: Theme,
	context: Pick<RenderContext, "lastComponent">,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const limit = args.limit === undefined ? "" : ` (limit ${args.limit})`;
	text.setText(`${theme.fg("accent", "find")} ${theme.fg("mdCode", args.pattern)}${limit}`);
	return text;
}

function renderFindText(result: AgentToolResult<unknown>, theme: Theme): string {
	const lines = resultText(result).split("\n");
	const candidates = lines.flatMap((line) => {
		const match = line.match(FIND_CANDIDATE);
		return match ? [match] : [];
	});
	const totalMatched = findTotalMatched(result);
	const summary =
		totalMatched === undefined || candidates.length === 0
			? undefined
			: `${theme.fg("success", String(candidates.length))} matches in ${theme.fg("success", String(totalMatched))} files:`;
	return [
		...(summary === undefined ? [] : [summary]),
		...lines
			.filter((line) => !FIND_SUMMARY.test(line) && !FIND_CURSOR.test(line))
			.map((line) => {
				const match = line.match(FIND_CANDIDATE);
				if (!match) return line;
				const path = match[1] ?? "";
				const matchType = match[2] ?? "";
				const reason = match[3];
				return `${findTag(matchType)} ${theme.fg("dim", path)}${reason ? ` (${reason})` : ""}`;
			}),
	].join("\n");
}

export function renderFindResult(
	result: AgentToolResult<unknown>,
	_options: unknown,
	theme: Theme,
	context: RenderContext,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const content = resultText(result);
	text.setText(context.isError ? theme.fg("error", content) : renderFindText(result, theme));
	return text;
}
