import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import type { TSchema } from "typebox";

const OWNER = "@hheei/pi-ext-tools";
const BUILT_IN_GROUP = "Built-in";

export function createCanonicalExecutionTool<TParams extends TSchema, TDetails, TState>(
	factory: (cwd: string) => ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	const template = factory(process.cwd());
	return {
		...template,
		async execute(toolCallId, params, signal, onUpdate, context) {
			if (
				typeof params === "object" &&
				params !== null &&
				"path" in params &&
				typeof params.path === "string" &&
				params.path.startsWith("output://")
			)
				throw new Error("Write/edit cannot modify output URLs");
			return factory(context.cwd).execute(toolCallId, params, signal, onUpdate, context);
		},
	};
}

export function registerCanonicalManagedTool<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	tool: ToolDefinition<TParams, TDetails, TState>,
	conflictsWith: readonly string[] = [],
): void {
	registerManagedLoadoutTool(
		pi,
		{
			id: tool.name,
			owner: OWNER,
			group: BUILT_IN_GROUP,
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			conflictsWith,
			defaultActive: true,
		},
		tool,
	);
}
