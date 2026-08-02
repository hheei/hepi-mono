import { createFindToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import type { FffRuntimeState } from "./fff/lifecycle.js";

/** ponytail: keep native find until FFF can preserve glob/path/result contract. */
export function registerFindTool(pi: ExtensionAPI, _state: FffRuntimeState): void {
	const template = createFindToolDefinition(process.cwd());
	const tool: typeof template = {
		...template,
		async execute(id, params, signal, onUpdate, context) {
			return createFindToolDefinition(context.cwd).execute(id, params, signal, onUpdate, context);
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "find",
			owner: "@hheei/pi-ext-tools",
			group: "Tools",
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tool,
	);
}
