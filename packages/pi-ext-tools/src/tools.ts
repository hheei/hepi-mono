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
import { registerBashJobTool } from "./bash-job-tool.js";
import { createFffRuntimeState, type FffRuntimeState } from "./fff/lifecycle.js";
import type { EditMode } from "./fff/settings.js";
import { registerFindTool } from "./find.js";
import { registerGrepTool } from "./grep.js";
import { createToolTui, type ToolTui } from "./pretty/frame.js";
import { registerReadTool } from "./read.js";

const OWNER = "@hheei/pi-ext-tools";
const BUILT_IN_GROUP = "Built-in";

/**
 * Register each catalog name once, while creating execution definitions from the
 * call's cwd. This preserves Pi's schema, abort, streaming, renderer, and file
 * semantics without pinning a tool definition to extension construction cwd.
 */
function registerCanonicalTool<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	factory: (cwd: string) => ToolDefinition<TParams, TDetails, TState>,
	tui: ToolTui,
	conflictsWith: readonly string[] = [],
): void {
	const template = factory(process.cwd());
	const tool: ToolDefinition<TParams, TDetails, TState> = {
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
		tui.frame(tool),
	);
}

/** Statically registers the explicitly approved canonical tool catalog. */
export function registerTools(
	pi: ExtensionAPI,
	state: FffRuntimeState = createFffRuntimeState(),
	tui: ToolTui = createToolTui(),
	editMode: EditMode = "apply_patch",
): void {
	registerReadTool(pi, state, tui);
	registerGrepTool(pi, state, tui);
	registerFindTool(pi, state, tui);
	if (editMode === "native") {
		registerCanonicalTool(pi, createEditToolDefinition, tui);
		registerCanonicalTool(pi, createWriteToolDefinition, tui);
	}
	registerBashTool(pi, state, tui);
	registerBashJobTool(pi, state, tui);
	if (editMode === "apply_patch") registerApplyPatchTool(pi, tui);
}
