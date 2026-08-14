import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { warmApplyPatchCoordinator } from "./apply-patch/coordinator-client.js";
import { registerApplyPatchGuard } from "./apply-patch-guard.js";
import { isApplyPatchToolDetails } from "./apply-patch-tool.js";
import { createFffRuntimeState, registerFffLifecycle } from "./fff/lifecycle.js";
import { registerCommands } from "./fff/register-commands.js";
import { readEditMode, resolveEditCatalog } from "./fff/settings.js";
import { createToolTui } from "./pretty/frame.js";
import { registerEditCatalog, registerTools } from "./tools.js";

/** Registers pi-ext-tools' static, canonical tool catalog. */
export default function piExtToolsExtension(pi: ExtensionAPI): void {
	const state = createFffRuntimeState();
	const tui = createToolTui();
	const editMode = readEditMode();
	let editCatalog = editMode === "auto" ? undefined : resolveEditCatalog(editMode, undefined);
	pi.on("session_start", (_event, ctx) => {
		if (editCatalog !== undefined) return;
		editCatalog = resolveEditCatalog(editMode, ctx.model);
		registerEditCatalog(pi, tui, editCatalog);
	});
	pi.on("agent_start", (_event, ctx) => {
		tui.beginTrace();
		// Model streaming usually covers coordinator cold start before its first tool call.
		if (editCatalog === "apply_patch")
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
	registerTools(pi, state, tui, editCatalog ?? "none");
	registerApplyPatchGuard(pi);
	registerCommands(pi, { getRuntime: () => state.getRuntime() ?? null });
	registerFffLifecycle(pi, state);
}
