import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { warmApplyPatchCoordinator } from "./apply-patch/coordinator-client.js";
import { registerApplyPatchGuard } from "./apply-patch-guard.js";
import { isApplyPatchToolDetails } from "./apply-patch-tool.js";
import { createFffRuntimeState, registerFffLifecycle } from "./fff/lifecycle.js";
import { registerCommands } from "./fff/register-commands.js";
import { readEditMode } from "./fff/settings.js";
import { createToolTui } from "./pretty/frame.js";
import { registerTools } from "./tools.js";

/** Registers pi-ext-tools' static, canonical tool catalog. */
export default function piExtToolsExtension(pi: ExtensionAPI): void {
	const state = createFffRuntimeState();
	const tui = createToolTui();
	const editMode = readEditMode();
	pi.on("agent_start", (_event, ctx) => {
		tui.beginTrace();
		// Model streaming usually covers coordinator cold start before its first tool call.
		if (editMode === "apply_patch")
			void warmApplyPatchCoordinator(ctx.cwd, ctx.signal).catch(() => undefined);
	});
	pi.on("tool_result", (event) => {
		if (
			event.toolName !== "apply_patch" ||
			!isApplyPatchToolDetails(event.details) ||
			event.details.status === "success"
		)
			return;
		return { isError: true };
	});
	registerTools(pi, state, tui, editMode);
	registerApplyPatchGuard(pi);
	registerCommands(pi, { getRuntime: () => state.getRuntime() ?? null });
	registerFffLifecycle(pi, state);
}
