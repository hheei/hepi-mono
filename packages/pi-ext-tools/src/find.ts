import { createFindToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { renderFindCall, renderFindResult } from "./search-renderer.js";

const OWNER = "@hheei/pi-ext-tools";

/** ponytail: keep native find until FFF can preserve glob/path/result contract. */
export function registerFindTool(pi: ExtensionAPI, _state: FffRuntimeState): void {
	const template = createFindToolDefinition(process.cwd());
	const tool: typeof template = {
		...template,
		renderCall: (args, theme, context) => renderFindCall(args, theme, context),
		renderResult: (result, options, theme, context) =>
			renderFindResult(result, options, theme, context),
		async execute(id, params, signal, onUpdate, context) {
			if (typeof params.path === "string" && params.path.startsWith("artifact://"))
				throw new Error("find cannot search artifact URLs");
			return createFindToolDefinition(context.cwd).execute(id, params, signal, onUpdate, context);
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
