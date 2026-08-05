import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { createFffRuntimeState, type FffRuntimeState } from "./fff/lifecycle.js";

const OWNER = "@hheei/pi-ext-tools";

/** Registers read while recreating execution for the call cwd. */
export function registerReadTool(
	pi: ExtensionAPI,
	state: FffRuntimeState = createFffRuntimeState(),
): void {
	const template = createReadToolDefinition(process.cwd());
	const tool: typeof template = {
		...template,
		async execute(toolCallId, params, signal, onUpdate, context) {
			const original = createReadToolDefinition(context.cwd);
			const artifacts = state.getArtifacts();
			if (artifacts !== undefined && params.path.startsWith("artifact://"))
				return {
					content: [{ type: "text" as const, text: artifacts.read(params.path) }],
					details: undefined,
				};
			if (!state.getSettings().readEnhancement)
				return original.execute(toolCallId, params, signal, onUpdate, context);
			const runtime = state.getRuntime();
			if (!runtime) return original.execute(toolCallId, params, signal, onUpdate, context);
			try {
				const resolved = await runtime.resolvePath(params.path, { allowDirectory: false });
				if (resolved.isErr())
					return original.execute(toolCallId, params, signal, onUpdate, context);
				return original.execute(
					toolCallId,
					{ ...params, path: resolved.value.relativePath },
					signal,
					onUpdate,
					context,
				);
			} catch {
				return original.execute(toolCallId, params, signal, onUpdate, context);
			}
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "read",
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
