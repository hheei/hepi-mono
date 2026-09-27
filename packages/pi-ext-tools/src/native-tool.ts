import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type ManagedToolRegistration, registerManagedTool } from "@hheei/pi-ext-core";
import type { TSchema } from "typebox";

const OWNER = "@hheei/pi-ext-tools";

export function createCanonicalExecutionTool<TParams extends TSchema, TDetails, TState>(
	factory: (cwd: string) => ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	const template = factory(process.cwd());
	return {
		...template,
		async execute(toolCallId, params, signal, onUpdate, context) {
			return factory(context.cwd).execute(toolCallId, params, signal, onUpdate, context);
		},
	};
}

export function createCanonicalToolRegistration(id: string): ManagedToolRegistration {
	return { id, owner: OWNER };
}

export function registerCanonicalTool<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	registration: ManagedToolRegistration,
	tool: ToolDefinition<TParams, TDetails, TState>,
): void {
	registerManagedTool(pi, registration, tool);
}
