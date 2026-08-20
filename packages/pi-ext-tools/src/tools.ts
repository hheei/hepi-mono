import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createToolTui,
	type ExtensionLifecycleContext,
	setManagedLoadoutToolsActive,
	type ToolTui,
} from "@hheei/pi-ext-core";
import { APPLY_PATCH_TOOL_REGISTRATION, registerApplyPatchTool } from "./apply-patch-tool.js";
import { registerBashTool } from "./bash.js";
import { registerBashJobTool } from "./bash-job-tool.js";
import { EDIT_TOOL_REGISTRATION, registerEditTool } from "./edit.js";
import { createFffRuntimeState, type FffRuntimeState } from "./fff/lifecycle.js";
import type { EditCatalog } from "./fff/settings.js";
import { registerFindTool } from "./find.js";
import { registerGrepTool } from "./grep.js";
import { registerReadTool } from "./read.js";
import { registerWriteTool, WRITE_TOOL_REGISTRATION } from "./write.js";

const NATIVE_EDIT_REGISTRATIONS = [EDIT_TOOL_REGISTRATION, WRITE_TOOL_REGISTRATION] as const;
const APPLY_PATCH_REGISTRATIONS = [APPLY_PATCH_TOOL_REGISTRATION] as const;

/** Activates and publishes only the resolved execution catalog. */
export function activateEditCatalog(
	context: ExtensionLifecycleContext,
	catalog: EditCatalog,
): void {
	setManagedLoadoutToolsActive(context, NATIVE_EDIT_REGISTRATIONS, catalog === "native");
	setManagedLoadoutToolsActive(context, APPLY_PATCH_REGISTRATIONS, catalog === "apply_patch");
}

/** Statically registers the explicitly approved canonical tool catalog. */
export function registerTools(
	pi: ExtensionAPI,
	state: FffRuntimeState = createFffRuntimeState(),
	tui: ToolTui = createToolTui(),
): void {
	registerReadTool(pi, state, tui);
	registerGrepTool(pi, state, tui);
	registerFindTool(pi, state, tui);
	registerEditTool(pi, tui);
	registerWriteTool(pi, tui);
	registerBashTool(pi, state, tui);
	registerBashJobTool(pi, state, tui);
	registerApplyPatchTool(pi, tui, state);
}
