import { createGrepToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { buildGrepDetails } from "./fff/extension-common.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import {
	buildFffQuery,
	containsRegexSyntax,
	filterNativeGrepText,
	isValidRegexPattern,
	supportsFffPath,
} from "./fff/query.js";
import { addGrepSummary, normalizeNativeGrepResult } from "./grep-format.js";
import { renderGrepCall, renderGrepResult } from "./search-renderer.js";

const OWNER = "@hheei/pi-ext-tools";
const DEFAULT_LIMIT = 20;
const ARTIFACT_PREFIX = "artifact:" + "//";
const artifactCursors = new Map<
	string,
	{
		path: string;
		pattern: string;
		caseSensitive: boolean | undefined;
		context: number | undefined;
		limit: number;
		offset: number;
	}
>();
let artifactCursorSequence = 0;

const schema = Type.Object({
	pattern: Type.String({ description: "Search pattern (literal text or regex)" }),
	path: Type.Optional(Type.String({ description: "Directory, filename, or glob path constraint" })),
	exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
	caseSensitive: Type.Optional(
		Type.Boolean({ description: "Force case-sensitive matching. Default uses smart-case." }),
	),
	context: Type.Optional(
		Type.Number({
			description: "Context lines before and after each match (default: 1 before, 3 after)",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Max matches (default 20)" })),
	cursor: Type.Optional(Type.String({ description: "Pagination cursor from the previous result" })),
});

function nativeParams(params: {
	pattern: string;
	path?: string;
	exclude?: string | string[];
	caseSensitive?: boolean;
	context?: number;
	limit?: number;
	cursor?: string;
}): {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
} {
	const isRegex = containsRegexSyntax(params.pattern) && isValidRegexPattern(params.pattern);
	const smartCase =
		params.caseSensitive !== true && params.pattern === params.pattern.toLowerCase();
	return {
		pattern: params.pattern,
		...(params.path === undefined
			? {}
			: params.path.match(/[*?[{]/)
				? { glob: params.path }
				: { path: params.path }),
		...(smartCase ? { ignoreCase: true } : {}),
		...(isRegex ? {} : { literal: true }),
		context: Math.max(0, params.context ?? 3),
		...(params.limit === undefined ? {} : { limit: params.limit }),
	};
}

function escapeLiteral(pattern: string): string {
	return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function artifactCursor(value: {
	path: string;
	pattern: string;
	caseSensitive: boolean | undefined;
	context: number | undefined;
	limit: number;
	offset: number;
}): string {
	const cursor = `artifact-grep:${++artifactCursorSequence}`;
	artifactCursors.set(cursor, value);
	if (artifactCursors.size > 200) {
		const oldest = artifactCursors.keys().next().value;
		if (typeof oldest === "string") artifactCursors.delete(oldest);
	}
	return cursor;
}

function searchArtifact(
	path: string,
	text: string,
	params: {
		pattern: string;
		caseSensitive?: boolean;
		context?: number;
		limit?: number;
		cursor?: string;
	},
): string {
	const resumed = params.cursor === undefined ? undefined : artifactCursors.get(params.cursor);
	if (params.cursor !== undefined && resumed === undefined)
		throw new Error("Invalid or expired artifact grep cursor.");
	const pattern = resumed?.pattern ?? params.pattern;
	const caseSensitive = resumed?.caseSensitive ?? params.caseSensitive;
	const context = resumed?.context ?? params.context;
	const limit = resumed?.limit ?? Math.max(1, params.limit ?? DEFAULT_LIMIT);
	const offset = resumed?.offset ?? 0;
	const source = containsRegexSyntax(pattern) ? pattern : escapeLiteral(pattern);
	let expression: RegExp;
	try {
		expression = new RegExp(
			source,
			caseSensitive === true || pattern !== pattern.toLowerCase() ? "" : "i",
		);
	} catch {
		expression = new RegExp(escapeLiteral(pattern), caseSensitive === true ? "" : "i");
	}
	const lines = text.split("\n");
	const matches = lines.flatMap((line, index) => (expression.test(line) ? [index] : []));
	const page = matches.slice(offset, offset + limit);
	if (page.length === 0) return "No match found";
	const requestedContext = Math.max(0, context ?? 1);
	const before = requestedContext;
	const after = context === undefined ? 3 : requestedContext;
	const showContext = matches.length <= 30 && page.length <= 10;
	const rendered = new Map<number, boolean>();
	for (const index of page) {
		if (showContext) {
			for (
				let line = Math.max(0, index - before);
				line <= Math.min(lines.length - 1, index + after);
				line += 1
			)
				rendered.set(line, rendered.get(line) === true || line === index);
		} else rendered.set(index, true);
	}
	const output = [path];
	for (const [index, isMatch] of [...rendered.entries()].sort(([left], [right]) => left - right))
		output.push(`${index + 1}${isMatch ? ":" : "│"}${lines[index] ?? ""}`);
	if (offset + page.length < matches.length)
		output.push(
			`cursor: ${artifactCursor({
				path,
				pattern,
				caseSensitive,
				context,
				limit,
				offset: offset + page.length,
			})}`,
		);
	return output.join("\n");
}

export function registerGrepTool(pi: ExtensionAPI, state: FffRuntimeState): void {
	const tool = {
		name: "grep",
		label: "grep",
		description:
			"Search file contents. Smart-case, auto-detect regex or literal, git-aware, frecency-ranked. Default limit 20.",
		promptSnippet: "Grep contents",
		promptGuidelines: [
			"grep: prefer bare identifiers; literal queries are most efficient.",
			"grep: use path to include a scope and exclude to remove noise.",
			"grep: set caseSensitive: true for exact case; otherwise smart-case applies.",
			"grep: after 1-2 searches, read the top match. AVOID `ripgrep` through the `bash` tool; use grep.",
		],
		parameters: schema,
		renderCall: renderGrepCall,
		renderResult: renderGrepResult,
		async execute(
			id: string,
			params: {
				pattern: string;
				path?: string;
				exclude?: string | string[];
				caseSensitive?: boolean;
				context?: number;
				limit?: number;
				cursor?: string;
			},
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			context: { cwd: string },
		) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const artifacts = state.getArtifacts();
			const resumedArtifact =
				params.cursor === undefined ? undefined : artifactCursors.get(params.cursor);
			const artifactPath = resumedArtifact?.path ?? params.path;
			if (artifactPath?.startsWith(ARTIFACT_PREFIX)) {
				if (artifacts === undefined) throw new Error("Artifact registry is unavailable.");
				return {
					content: [
						{
							type: "text" as const,
							text: searchArtifact(artifactPath, artifacts.read(artifactPath), params),
						},
					],
					details: undefined,
				};
			}
			const native = async () => {
				const result = await createGrepToolDefinition(context.cwd).execute(
					id,
					nativeParams(params),
					signal,
					onUpdate,
					context as never,
				);
				return normalizeNativeGrepResult({
					...result,
					content: result.content.map((part) =>
						part.type === "text" && "text" in part
							? { ...part, text: filterNativeGrepText(part.text, params.exclude) }
							: part,
					),
				});
			};
			const runtime = state.getRuntime();
			if (
				!state.getSettings().grepEnhancement ||
				runtime === undefined ||
				!supportsFffPath(params.path, context.cwd)
			)
				return native();
			const result = await runtime.grepSearch({
				pattern: params.pattern,
				mode: containsRegexSyntax(params.pattern) ? "regex" : "plain",
				...(params.caseSensitive === undefined ? {} : { caseSensitive: params.caseSensitive }),
				constraints: buildFffQuery(params.path, "", params.exclude, context.cwd).trim(),
				beforeContext: Math.max(0, params.context ?? 1),
				afterContext: Math.max(0, params.context ?? 3),
				limit: Math.max(1, params.limit ?? DEFAULT_LIMIT),
				...(params.cursor === undefined ? {} : { cursor: params.cursor }),
				includeCursorHint: true,
			});
			if (signal?.aborted) throw new Error("Operation aborted");
			if (result.isErr()) return native();
			const files = new Set(result.value.items.map((item) => item.relativePath));
			return {
				content: [
					{
						type: "text" as const,
						text: addGrepSummary(result.value.formatted, {
							matches: result.value.items.length,
							files: files.size,
						}),
					},
				],
				details: buildGrepDetails(result.value),
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
		tool,
	);
}
