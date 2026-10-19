import {
	createFindToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createOptionalToolRenderers, SEARCH_TIMEOUT_MS, textToolResult } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { filterNativeFindText, nativeFallbackPattern } from "./find-query.js";
import { renderFindResult } from "./search-renderer.js";
import { FIND_TIMEOUT_RECOVERY } from "./search-timeout.js";

const FIND_DESCRIPTION =
	"Fuzzy path and glob search. Matches the whole repo-relative path, frecency-ranked and git-aware. Default limit 30.";
const FIND_PROMPT_SNIPPET = "Find files by path or glob";
const FIND_PROMPT_GUIDELINES: string[] = [
	"find: prefer 1-2 terms; extra words narrow the whole-path match.",
	"find: use path for exact glob constraints and exclude to remove noise.",
	"find: use for paths, not content. Use grep for content. AVOID `find` or `fd` through the `bash` tool; use find.",
	"find: if search times out, narrow path/glob, add exclude, or use more specific terms.",
] as const;
const FIND_PARAMETER_DESCRIPTIONS = {
	pattern:
		"Fuzzy filename search and glob search. Frecency-ranked, git-aware. Multi-word narrows the result (AND).",
	path: "Path constraint: directory prefix, filename, or glob, applied to the repo-relative path.",
	limit: "Max results per page (default 30)",
	cursor: "Pagination cursor from the previous result",
} as const;

type FindParams = {
	readonly pattern: string;
	readonly path?: string;
	readonly exclude?: string | string[];
	readonly limit?: number;
	readonly cursor?: string;
};

const schema = Type.Object({
	pattern: Type.String({ description: FIND_PARAMETER_DESCRIPTIONS.pattern }),
	path: Type.Optional(Type.String({ description: FIND_PARAMETER_DESCRIPTIONS.path })),
	exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
	limit: Type.Optional(Type.Number({ description: FIND_PARAMETER_DESCRIPTIONS.limit })),
	cursor: Type.Optional(Type.String({ description: FIND_PARAMETER_DESCRIPTIONS.cursor })),
});

function nativeParams(params: FindParams): { pattern: string; path?: string; limit?: number } {
	return {
		pattern: params.path?.match(/[*?[{]/) ? params.path : nativeFallbackPattern(params.pattern),
		...(params.path === undefined || params.path.match(/[*?[{]/) ? {} : { path: params.path }),
		...(params.limit === undefined ? {} : { limit: params.limit }),
	};
}

async function executeFind(
	id: string,
	params: FindParams,
	signal: AbortSignal,
	onUpdate: undefined,
	context: { cwd: string },
) {
	if (signal.aborted) throw new Error("Operation aborted");
	const result = await createFindToolDefinition(context.cwd).execute(
		id,
		nativeParams(params),
		signal,
		onUpdate,
		context as never,
	);
	return {
		...result,
		content: result.content.map((part) =>
			part.type === "text" && "text" in part
				? { ...part, text: filterNativeFindText(part.text, params.exclude) }
				: part,
		),
	};
}

export function registerFindTool(pi: ExtensionAPI): ToolDefinition {
	const tool = {
		name: "find",
		label: "find",
		description: FIND_DESCRIPTION,
		promptSnippet: FIND_PROMPT_SNIPPET,
		promptGuidelines: FIND_PROMPT_GUIDELINES,
		parameters: schema,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		...createOptionalToolRenderers(pi, "find", {
			renderResult: renderFindResult,
		}),
		async execute(
			id: string,
			params: FindParams,
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			context: { cwd: string },
		) {
			const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
			const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
			try {
				return await executeFind(id, params, combined, onUpdate, context);
			} catch (error) {
				if (timeout.aborted && signal?.aborted !== true) {
					return textToolResult(FIND_TIMEOUT_RECOVERY, {
						outcome: "timeout",
						...(params.path === undefined ? {} : { path: params.path }),
						timedOut: true,
					});
				}
				throw error;
			}
		},
	};
	pi.registerTool(tool as ToolDefinition);
	return tool as ToolDefinition;
}
