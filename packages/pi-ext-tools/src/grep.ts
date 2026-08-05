import { createGrepToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { buildGrepDetails } from "./fff/extension-common.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import {
	buildFffQuery,
	containsRegexSyntax,
	filterNativeGrepText,
	supportsFffPath,
} from "./fff/query.js";
import { addGrepSummary, normalizeNativeGrepResult } from "./grep-format.js";
import { renderGrepCall, renderGrepResult } from "./search-renderer.js";

const OWNER = "@hheei/pi-ext-tools";
const DEFAULT_LIMIT = 20;

const schema = Type.Object({
	pattern: Type.String({ description: "Search pattern (literal text or regex)" }),
	path: Type.Optional(Type.String({ description: "Directory, filename, or glob path constraint" })),
	exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
	caseSensitive: Type.Optional(
		Type.Boolean({ description: "Force case-sensitive matching. Default uses smart-case." }),
	),
	limit: Type.Optional(Type.Number({ description: "Max matches (default 20)" })),
	cursor: Type.Optional(Type.String({ description: "Pagination cursor from the previous result" })),
});

function nativeParams(params: {
	pattern: string;
	path?: string;
	exclude?: string | string[];
	caseSensitive?: boolean;
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
	const isRegex = containsRegexSyntax(params.pattern);
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
		context: 3,
		...(params.limit === undefined ? {} : { limit: params.limit }),
	};
}

export function registerGrepTool(pi: ExtensionAPI, state: FffRuntimeState): void {
	const tool = {
		name: "grep",
		label: "grep",
		description:
			"Grep file contents. Smart-case, auto-detects regex or literal, git-aware. Results are frecency-ranked; matches within a file stay in source order. Default limit 20.",
		promptSnippet: "Grep contents",
		promptGuidelines: [
			"grep: prefer bare identifiers as patterns. Literal queries are most efficient.",
			"grep: use path to include a scope and exclude to remove noise.",
			"grep: use caseSensitive: true when exact case is required.",
			"grep: after 1-2 greps, read the top match instead of more greps.",
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
				limit?: number;
				cursor?: string;
			},
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			context: { cwd: string },
		) {
			if (signal?.aborted) throw new Error("Operation aborted");
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
				beforeContext: 1,
				afterContext: 3,
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
