import { createGrepToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { grepNeedsBuiltinFallback, inferFffGrepMode } from "./fff/extension-common.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { renderGrepCall, renderGrepResult } from "./search-renderer.js";

const OWNER = "@hheei/pi-ext-tools";
export function registerGrepTool(pi: ExtensionAPI, state: FffRuntimeState): void {
	const template = createGrepToolDefinition(process.cwd());
	const tool: typeof template = {
		...template,
		renderCall: (args, theme, context) => renderGrepCall(args, theme, context),
		renderResult: (result, options, theme, context) =>
			renderGrepResult(result, options, theme, context),
		async execute(id, params, signal, onUpdate, context) {
			const original = createGrepToolDefinition(context.cwd);
			const native = () => original.execute(id, params, signal, onUpdate, context);
			const artifacts = state.getArtifacts();
			if (
				params.path !== undefined &&
				artifacts !== undefined &&
				params.path.startsWith("artifact://")
			) {
				const text = artifacts.read(params.path);
				const pattern = params.literal
					? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
					: params.pattern;
				const expression = new RegExp(pattern, params.ignoreCase ? "i" : "");
				const lines = text
					.split("\\n")
					.flatMap((line: string, index: number) =>
						expression.test(line) ? [`${index + 1}:${line}`] : [],
					);
				return {
					content: [{ type: "text" as const, text: lines.join("\\n") }],
					details: undefined,
				};
			}
			const runtime = state.getRuntime();
			if (
				!runtime ||
				!state.getSettings().grepEnhancement ||
				grepNeedsBuiltinFallback({
					pattern: params.pattern,
					...(params.ignoreCase === undefined ? {} : { ignoreCase: params.ignoreCase }),
				})
			)
				return native();
			try {
				const result = await runtime.grepSearch({
					pattern: params.pattern,
					mode: inferFffGrepMode(params.literal),
					...(params.path === undefined ? {} : { pathQuery: params.path }),
					...(params.glob === undefined ? {} : { glob: params.glob }),
					...(params.context === undefined ? {} : { context: params.context }),
					...(params.limit === undefined ? {} : { limit: params.limit }),
				});
				if (result.isErr()) return native();
				return {
					content: [{ type: "text" as const, text: result.value.formatted }],
					details: undefined,
				};
			} catch {
				return native();
			}
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
