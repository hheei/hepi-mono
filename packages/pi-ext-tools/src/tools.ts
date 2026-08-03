import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import type { TSchema } from "typebox";
import { registerApplyPatchTool } from "./apply-patch-tool.js";
import { registerBashTool } from "./bash.js";
import { createFffRuntimeState, type FffRuntimeState } from "./fff/lifecycle.js";
import { registerFindTool } from "./find.js";
import { registerGrepTool } from "./grep.js";
import { registerReadTool } from "./read.js";

const OWNER = "@hheei/pi-ext-tools";

/**
 * Register each catalog name once, while creating execution definitions from the
 * call's cwd. This preserves Pi's schema, abort, streaming, renderer, and file
 * semantics without pinning a tool definition to extension construction cwd.
 */
function registerCanonicalTool<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	factory: (cwd: string) => ToolDefinition<TParams, TDetails, TState>,
): void {
	const template = factory(process.cwd());
	const tool: ToolDefinition<TParams, TDetails, TState> = {
		...template,
		async execute(toolCallId, params, signal, onUpdate, context) {
			return factory(context.cwd).execute(toolCallId, params, signal, onUpdate, context);
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: tool.name,
			owner: OWNER,
			group: "Tools",
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tool,
	);
}

/** Statically registers the explicitly approved canonical tool catalog. */
export function registerTools(
	pi: ExtensionAPI,
	state: FffRuntimeState = createFffRuntimeState(),
): void {
	registerReadTool(pi, state);
	registerGrepTool(pi, state);
	registerFindTool(pi, state);
	registerCanonicalTool(pi, createEditToolDefinition);
	registerCanonicalTool(pi, createWriteToolDefinition);
	registerBashTool(pi);
	registerApplyPatchTool(pi);
}
