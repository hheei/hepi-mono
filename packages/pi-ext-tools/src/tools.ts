import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApplyPatchTool } from "./apply-patch-tool.js";
import { registerBashTool } from "./bash.js";
import { registerBashJobTool } from "./bash-job-tool.js";
import { registerEditTool } from "./edit.js";
import { createFffRuntimeState, type FffRuntimeState } from "./fff/lifecycle.js";
import type { EditMode } from "./fff/settings.js";
import { registerFindTool } from "./find.js";
import { registerGrepTool } from "./grep.js";
import { createToolTui, type ToolTui } from "./pretty/frame.js";
import { registerReadTool } from "./read.js";
import { registerWriteTool } from "./write.js";

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
		registerEditTool(pi, tui);
		registerWriteTool(pi, tui);
	}
	registerBashTool(pi, state, tui);
	registerBashJobTool(pi, state, tui);
	if (editMode === "apply_patch") registerApplyPatchTool(pi, tui);
}
