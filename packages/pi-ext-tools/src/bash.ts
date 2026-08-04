import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";

const OWNER = "@hheei/pi-ext-tools";

/** Keeps Pi's bash renderer authoritative while recreating execution for the call cwd. */
export function registerBashTool(pi: ExtensionAPI): void {
	const template = createBashToolDefinition(process.cwd());
	const tool: typeof template = {
		...template,
		async execute(toolCallId, params, signal, onUpdate, context) {
			return createBashToolDefinition(context.cwd).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				context,
			);
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "bash",
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
