import { createFindToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { formatCandidateLines } from "./fff/fff.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { renderFindCall, renderFindResult } from "./search-renderer.js";

const OWNER = "@hheei/pi-ext-tools";
const GLOB_SYNTAX = /[*?[{]/;

function canUseFffFind(
	params: { readonly pattern: string; readonly path?: string; readonly limit?: number },
	state: FffRuntimeState,
): boolean {
	return (
		state.getSettings().findEnhancement &&
		state.getRuntime() !== undefined &&
		params.path === undefined &&
		!GLOB_SYNTAX.test(params.pattern) &&
		(params.limit === undefined || (Number.isInteger(params.limit) && params.limit > 0))
	);
}

/** ponytail: FFF find supports only unscoped non-glob queries; add native-equivalent glob/root support before widening. */
export function registerFindTool(pi: ExtensionAPI, state: FffRuntimeState): void {
	const template = createFindToolDefinition(process.cwd());
	const tool: typeof template = {
		...template,
		description:
			"Search for files by FFF fuzzy path query when available; otherwise searches by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Default limit 1000.",
		promptSnippet: "Find files by fuzzy path query or glob (respects .gitignore)",
		promptGuidelines: [
			"find: use for paths, not content. Use grep for content.",
			"find: keep glob patterns precise; use a path-containing pattern such as 'src/**/*.ts' when the scope is known.",
			"find: use limit when a broad pattern may return many files.",
		],
		renderCall: (args, theme, context) => renderFindCall(args, theme, context),
		renderResult: (result, options, theme, context) =>
			renderFindResult(result, options, theme, context),
		async execute(id, params, signal, onUpdate, context) {
			if (typeof params.path === "string" && params.path.startsWith("artifact://"))
				throw new Error("find cannot search artifact URLs");
			const native = () =>
				createFindToolDefinition(context.cwd).execute(id, params, signal, onUpdate, context);
			if (!canUseFffFind(params, state)) return native();
			const runtime = state.getRuntime();
			if (runtime === undefined) return native();
			if (signal?.aborted) throw new Error("Operation aborted");
			try {
				const candidates = await runtime.searchFileCandidates(params.pattern, params.limit ?? 1000);
				if (signal?.aborted) throw new Error("Operation aborted");
				if (candidates.isErr()) return native();
				if (candidates.value.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No files found matching pattern" }],
						details: undefined,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: formatCandidateLines(candidates.value, params.limit ?? 1000).join("\n"),
						},
					],
					details: undefined,
				};
			} catch (error) {
				if (signal?.aborted) throw error;
				return native();
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
		tool,
	);
}
