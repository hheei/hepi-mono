import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createFindTool, createGrepTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	ExternalGrepScopeError,
	FinderOperationError,
	RuntimeInitializationError,
} from "./errors.js";
import {
	buildFindFilesDetails,
	buildGrepDetails,
	buildGrepFailureMessage,
	buildReadFailureMessage,
	type FeatureKey,
	FFF_RUNTIME_NOT_READY_TEXT,
	grepNeedsBuiltinFallback,
	inferFffGrepMode,
	locationToReadParams,
	normalizeMode,
	normalizeOutputMode,
} from "./extension-common.js";
import type { FffRuntime } from "./fff.js";
import { DEFAULT_GREP_TIMEOUT_MS } from "./fff-types.js";

export type ToolRegistrationDeps = {
	getRuntime(): FffRuntime | null;
	isFeatureEnabled(feature: FeatureKey): boolean;
	agentToolsDisabledText(): string;
};

function textResult<T>(text: string, details: T) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

type GrepRenderArgs = {
	readonly pattern: string;
	readonly path?: string | undefined;
	readonly limit?: number | undefined;
};

const DEFAULT_GREP_TIMEOUT_SECONDS = DEFAULT_GREP_TIMEOUT_MS / 1_000;

function grepTimeoutMs(timeout: number | undefined): number {
	return Math.round((timeout ?? DEFAULT_GREP_TIMEOUT_SECONDS) * 1_000);
}

type GrepRenderContext = {
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

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => ("text" in part ? part.text : ""))
		.join("\n");
}

function renderGrepCall(
	args: GrepRenderArgs,
	theme: Theme,
	context: Pick<GrepRenderContext, "lastComponent">,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const scope = args.path ? ` in ${theme.fg("dim", args.path)}` : "";
	const limit = args.limit === undefined ? "" : ` (limit ${args.limit})`;
	text.setText(
		`${theme.fg("accent", "grep")} ${theme.fg("toolOutput", `\`/${args.pattern}/\``)}${scope}${limit}`,
	);
	return text;
}

function renderGrepText(text: string, theme: Theme): string {
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
				return `${theme.fg("success", summary[1] ?? "0")} matches in ${theme.fg("success", summary[2] ?? "0")} files:`;
			}

			const fileHeader = line.match(GREP_FILE_HEADER);
			if (fileHeader) {
				return `${theme.fg("dim", fileHeader[1] ?? "")} (${theme.fg("success", fileHeader[2] ?? "0")} matches)`;
			}

			const matchLine = line.match(GREP_MATCH_LINE);
			if (!matchLine) return line;
			const lineNumber = matchLine[1] ?? "";
			const content = (matchLine[2] ?? "").replace(/^ /, "");
			return `${theme.fg("dim", lineNumber.padStart(lineWidth, " "))}${theme.fg("dim", ":")}  ${content}`;
		})
		.join("\n");
	return lines.some((line) => GREP_SUMMARY.test(line) || GREP_NO_MATCHES.test(line))
		? `\n${rendered}`
		: rendered;
}

function renderGrepResult(
	result: AgentToolResult<unknown>,
	_options: unknown,
	theme: Theme,
	context: GrepRenderContext,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const content = resultText(result).replace(/(?:\r?\n)+$/, "");
	text.setText(context.isError ? theme.fg("error", content) : renderGrepText(content, theme));
	return text;
}

type FindRenderArgs = {
	readonly query: string;
	readonly limit?: number | undefined;
};

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

function renderFindCall(
	args: FindRenderArgs,
	theme: Theme,
	context: Pick<GrepRenderContext, "lastComponent">,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const limit = args.limit === undefined ? "" : ` (limit ${args.limit})`;
	text.setText(`${theme.fg("accent", "find")}${theme.fg("dim", ` ${args.query}${limit}`)}`);
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

function renderFindResult(
	result: AgentToolResult<unknown>,
	_options: unknown,
	theme: Theme,
	context: GrepRenderContext,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const content = resultText(result);
	text.setText(context.isError ? theme.fg("error", content) : renderFindText(result, theme));
	return text;
}

export function registerTools(pi: ExtensionAPI, deps: ToolRegistrationDeps): void {
	const readTemplate = createReadTool(process.cwd());
	const grepTemplate = createGrepTool(process.cwd());

	const getAgentRuntime = <T>(disabledDetails: T, unavailableDetails: T) => {
		if (!deps.isFeatureEnabled("agentTools")) {
			return {
				kind: "disabled" as const,
				result: textResult(deps.agentToolsDisabledText(), disabledDetails),
			};
		}
		const runtime = deps.getRuntime();
		if (!runtime) {
			return {
				kind: "unavailable" as const,
				result: textResult(FFF_RUNTIME_NOT_READY_TEXT, unavailableDetails),
			};
		}
		return { kind: "ready" as const, runtime };
	};

	pi.registerTool({
		name: "read",
		label: "read",
		description: `${readTemplate.description} Accepts approximate file paths and resolves them with fff before reading.`,
		parameters: readTemplate.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const original = createReadTool(ctx.cwd);
			const runtime = deps.getRuntime();
			if (!runtime || !deps.isFeatureEnabled("builtInReadEnhancement")) {
				return original.execute(toolCallId, params, signal, onUpdate);
			}

			const resolution = await runtime.resolvePath(params.path, {
				allowDirectory: false,
				limit: 8,
			});
			return resolution.match({
				err: async (error) => {
					throw new Error(buildReadFailureMessage("read", params.path, error));
				},
				ok: async (resolved) => {
					void runtime.trackQuery(params.path, resolved.absolutePath);
					const locationParams = locationToReadParams(resolved, params.offset, params.limit);
					return original.execute(
						toolCallId,
						{
							...params,
							path: resolved.absolutePath,
							...(locationParams.offset === undefined ? {} : { offset: locationParams.offset }),
							...(locationParams.limit === undefined ? {} : { limit: locationParams.limit }),
						},
						signal,
						onUpdate,
					);
				},
			});
		},
	});

	const grepSchema = Type.Object({
		pattern: Type.String({ description: "Search pattern" }),
		mode: Type.Optional(Type.String({ description: "Search mode: plain, regex, or fuzzy" })),
		path: Type.Optional(Type.String({ description: "Optional exact or fuzzy file/folder scope" })),
		glob: Type.Optional(Type.String({ description: "Optional glob filter such as *.ts" })),
		constraints: Type.Optional(
			Type.String({ description: "Optional native FFF constraints such as *.ts !tests/ src/" }),
		),
		ignoreCase: Type.Optional(
			Type.Boolean({ description: "Case-insensitive search (default: smart case)" }),
		),
		literal: Type.Optional(
			Type.Boolean({ description: "Treat pattern as literal string instead of regex" }),
		),
		context: Type.Optional(
			Type.Number({ description: "Context lines before and after each match" }),
		),
		limit: Type.Optional(
			Type.Number({ description: "Maximum number of matches to return (default: 100)" }),
		),
		timeout: Type.Optional(
			Type.Number({ minimum: 1, description: "Timeout in seconds (default: 30)" }),
		),
		cursor: Type.Optional(Type.String({ description: "Cursor from a previous grep result" })),
		outputMode: Type.Optional(
			Type.String({ description: "Output mode: content, files_with_matches, count, or usage" }),
		),
	});

	pi.registerTool({
		name: "grep",
		label: "grep",
		description: `${grepTemplate.description} Uses fff for content search and can resolve approximate file or folder scopes.`,
		promptSnippet: "Search file contents (FFF-backed) with optional path/glob scope.",
		promptGuidelines: [
			"Prefer simple literal patterns over complex regex when possible.",
			"Use path/glob/constraints to narrow scope before trying another grep.",
			"Use outputMode=files_with_matches when content output is too noisy.",
			"After one or two good greps, read the best matching file.",
		],
		parameters: grepSchema,
		renderCall: renderGrepCall,
		renderResult: renderGrepResult,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const original = createGrepTool(ctx.cwd);
			const runtime = deps.getRuntime();
			const timeoutMs = grepTimeoutMs(params.timeout);
			const builtinParams = {
				pattern: params.pattern,
				...(params.path === undefined ? {} : { path: params.path }),
				...(params.glob === undefined ? {} : { glob: params.glob }),
				...(params.ignoreCase === undefined ? {} : { ignoreCase: params.ignoreCase }),
				...(params.literal === undefined ? {} : { literal: params.literal }),
				...(params.context === undefined ? {} : { context: params.context }),
				...(params.limit === undefined ? {} : { limit: params.limit }),
			};
			const executeBuiltinGrep = () => {
				const timeoutSignal = AbortSignal.timeout(timeoutMs);
				const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
				return original.execute(toolCallId, builtinParams, operationSignal, onUpdate);
			};
			const explicitMode = normalizeMode(params.mode);
			const fallbackLiteral =
				params.literal ?? (params.mode ? explicitMode !== "regex" : undefined);
			if (
				!runtime ||
				!deps.isFeatureEnabled("builtInGrepEnhancement") ||
				grepNeedsBuiltinFallback({
					pattern: params.pattern,
					...(params.ignoreCase === undefined ? {} : { ignoreCase: params.ignoreCase }),
					...(fallbackLiteral === undefined ? {} : { literal: fallbackLiteral }),
				})
			) {
				return executeBuiltinGrep();
			}

			const pattern = params.ignoreCase === true ? params.pattern.toLowerCase() : params.pattern;
			const outputMode = normalizeOutputMode(params.outputMode);
			const result = await runtime.grepSearch({
				pattern,
				mode: params.mode ? explicitMode : inferFffGrepMode(params.literal),
				...(params.path === undefined ? {} : { pathQuery: params.path }),
				...(params.glob === undefined ? {} : { glob: params.glob }),
				...(params.constraints === undefined ? {} : { constraints: params.constraints }),
				...(params.context === undefined ? {} : { context: params.context }),
				...(params.limit === undefined ? {} : { limit: params.limit }),
				timeBudgetMs: timeoutMs,
				...(params.cursor === undefined ? {} : { cursor: params.cursor }),
				includeCursorHint: false,
				...(outputMode === undefined ? {} : { outputMode }),
			});
			if (result.isErr()) {
				if (
					RuntimeInitializationError.is(result.error) ||
					FinderOperationError.is(result.error) ||
					ExternalGrepScopeError.is(result.error)
				)
					return executeBuiltinGrep();
				throw new Error(buildGrepFailureMessage(result.error, params.path));
			}
			return textResult(result.value.formatted, buildGrepDetails(result.value));
		},
	});

	pi.registerTool({
		name: "find_files",
		label: "Find Files",
		description: "Browse ranked file candidates for a fuzzy query using fff.",
		promptSnippet: "Explore which files exist for a topic before reading one.",
		promptGuidelines: [
			"Use `find_files` when exploring a topic, looking for a file, or needing paginated ranked candidates before reading.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Fuzzy file query" }),
			limit: Type.Optional(
				Type.Number({ description: "Maximum number of results to return (default: 20)" }),
			),
			cursor: Type.Optional(
				Type.String({ description: "Cursor from a previous find_files result" }),
			),
		}),
		renderCall: renderFindCall,
		renderResult: renderFindResult,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const guarded = getAgentRuntime(
				buildFindFilesDetails(undefined, "agentTools"),
				buildFindFilesDetails(),
			);
			if (guarded.kind === "unavailable") {
				const original = createFindTool(ctx.cwd);
				return original.execute(
					toolCallId,
					{
						pattern: `*${params.query}*`,
						...(params.limit === undefined ? {} : { limit: params.limit }),
					},
					signal,
					onUpdate,
				);
			}
			if (guarded.kind !== "ready") return guarded.result;
			const result = await guarded.runtime.findFiles({
				query: params.query,
				...(params.limit === undefined ? {} : { limit: params.limit }),
				...(params.cursor === undefined ? {} : { cursor: params.cursor }),
			});
			return result.match({
				err: (error) => {
					throw new Error(error.message);
				},
				ok: (value) => textResult(value.formatted, buildFindFilesDetails(value)),
			});
		},
	});

	pi.registerTool({
		name: "fff_multi_grep",
		label: "FFF Multi Grep",
		description: "Search file contents for any of multiple literal patterns using fff multi-grep.",
		promptSnippet: "Search for any of several literals at once using fff multi-grep.",
		promptGuidelines: [
			"Use `fff_multi_grep` to search multiple aliases or renamed symbols in one pass.",
		],
		parameters: Type.Object({
			patterns: Type.Array(Type.String({ description: "Literal pattern" }), { minItems: 1 }),
			path: Type.Optional(
				Type.String({ description: "Optional exact or fuzzy file/folder scope" }),
			),
			glob: Type.Optional(Type.String({ description: "Optional glob filter such as *.ts" })),
			constraints: Type.Optional(
				Type.String({ description: "Optional native FFF constraints such as *.ts !tests/ src/" }),
			),
			context: Type.Optional(
				Type.Number({ description: "Context lines before and after each match" }),
			),
			limit: Type.Optional(
				Type.Number({ description: "Maximum number of matches to return (default: 60)" }),
			),
			cursor: Type.Optional(
				Type.String({ description: "Cursor from a previous fff_multi_grep result" }),
			),
			outputMode: Type.Optional(
				Type.String({ description: "Output mode: content, files_with_matches, count, or usage" }),
			),
		}),
		async execute(_toolCallId, params) {
			const guarded = getAgentRuntime(
				buildGrepDetails(undefined, "agentTools"),
				buildGrepDetails(),
			);
			if (guarded.kind !== "ready") return guarded.result;
			const result = await guarded.runtime.multiGrepSearch({
				patterns: params.patterns,
				...(params.path === undefined ? {} : { pathQuery: params.path }),
				...(params.glob === undefined ? {} : { glob: params.glob }),
				...(params.constraints === undefined ? {} : { constraints: params.constraints }),
				...(params.context === undefined ? {} : { context: params.context }),
				limit: params.limit ?? 60,
				...(params.cursor === undefined ? {} : { cursor: params.cursor }),
				includeCursorHint: false,
				outputMode: normalizeOutputMode(params.outputMode) ?? "files_with_matches",
			});
			return result.match({
				err: (error) => {
					throw new Error(buildGrepFailureMessage(error, params.path));
				},
				ok: (value) => textResult(value.formatted, buildGrepDetails(value)),
			});
		},
	});
}
