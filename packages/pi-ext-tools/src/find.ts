import { createFindToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolTui, registerManagedLoadoutTool, type ToolTui } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import {
	buildFffQuery,
	filterNativeFindText,
	nativeFallbackPattern,
	supportsFffPath,
} from "./fff/query.js";
import {
	type FindToolDetails,
	findCollapsedFooter,
	formatFindModelOutput,
	renderFindResult,
} from "./search-renderer.js";
import { FIND_TIMEOUT_RECOVERY, SEARCH_TIMEOUT_MS } from "./search-timeout.js";

const OWNER = "@hheei/pi-ext-tools";
const ARTIFACT_PREFIX = "output:" + "//";
const DEFAULT_LIMIT = 30;
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
const NO_FIND_RESULTS = "No files found matching pattern";
const cursorStore = new Map<string, { query: string; limit: number; pageIndex: number }>();
let cursorSequence = 0;

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

function nextCursor(query: string, limit: number, pageIndex: number): string {
	const cursor = `find:${++cursorSequence}`;
	cursorStore.set(cursor, { query, limit, pageIndex });
	if (cursorStore.size > 200) {
		const oldest = cursorStore.keys().next().value;
		if (typeof oldest === "string") cursorStore.delete(oldest);
	}
	return cursor;
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		signal.addEventListener("abort", () => reject(new Error("Operation aborted")), {
			once: true,
		});
	});
}

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
	state: FffRuntimeState,
) {
	if (signal.aborted) throw new Error("Operation aborted");
	if (params.path?.startsWith(ARTIFACT_PREFIX)) throw new Error("find cannot search output URLs");
	const startedAt = performance.now();
	const native = async () => {
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
	};
	const runtime = state.getRuntime();
	if (
		!state.getSettings().findEnhancement ||
		runtime === undefined ||
		!supportsFffPath(params.path, context.cwd)
	) {
		return native();
	}
	const cursor = params.cursor === "" ? undefined : params.cursor;
	const resumed = cursor === undefined ? undefined : cursorStore.get(cursor);
	if (cursor !== undefined && resumed === undefined)
		throw new Error("Invalid or expired find cursor.");
	const limit = resumed?.limit ?? Math.max(1, params.limit ?? DEFAULT_LIMIT);
	const query =
		resumed?.query ?? buildFffQuery(params.path, params.pattern, params.exclude, context.cwd);
	const result = await Promise.race([
		runtime.findSearch({
			query,
			limit,
			pageIndex: resumed?.pageIndex ?? 0,
		}),
		rejectWhenAborted(signal),
	]);
	if (signal.aborted) throw new Error("Operation aborted");
	if (result.isErr()) {
		return native();
	}
	const details = {
		format: "canonical-find",
		candidates: result.value.items.map((candidate) => ({
			path: candidate.item.relativePath,
			...(candidate.score?.matchType === undefined ? {} : { matchType: candidate.score.matchType }),
		})),
		totalMatched: result.value.totalMatched,
		totalFiles: result.value.totalFiles,
		durationMs: Math.round(performance.now() - startedAt),
	} satisfies FindToolDetails;
	const cursorLine = result.value.hasMore
		? `cursor: ${nextCursor(query, limit, result.value.pageIndex + 1)}`
		: undefined;
	return {
		content: [
			{
				type: "text" as const,
				text:
					[formatFindModelOutput(details), cursorLine]
						.filter((line): line is string => line !== undefined && line !== "")
						.join("\n") || NO_FIND_RESULTS,
			},
		],
		details,
	};
}

export function registerFindTool(
	pi: ExtensionAPI,
	state: FffRuntimeState,
	tui: ToolTui = createToolTui(),
): void {
	const tool = {
		name: "find",
		label: "find",
		description: FIND_DESCRIPTION,
		promptSnippet: FIND_PROMPT_SNIPPET,
		promptGuidelines: FIND_PROMPT_GUIDELINES,
		parameters: schema,
		renderResult: renderFindResult,
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
				return await executeFind(id, params, combined, onUpdate, context, state);
			} catch (error) {
				if (timeout.aborted && signal?.aborted !== true)
					return {
						content: [{ type: "text" as const, text: FIND_TIMEOUT_RECOVERY }],
						details: { timedOut: true },
					};
				throw error;
			}
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "find",
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tui.frame(tool, {
			footer: findCollapsedFooter,
		}),
	);
}
