import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getToolTui, registerExtensionLifecycle, registerToolTuiTrace } from "@hheei/pi-ext-core";
import { warmApplyPatchCoordinator } from "./apply-patch/coordinator-client.js";
import { registerApplyPatchGuard } from "./apply-patch-guard.js";
import { isApplyPatchToolDetails } from "./apply-patch-tool.js";
import { createFffRuntimeState, registerFffLifecycle } from "./fff/lifecycle.js";
import { registerCommands } from "./fff/register-commands.js";
import { type EditCatalog, readEditMode, resolveEditCatalog } from "./fff/settings.js";
import { activateEditCatalog, registerTools } from "./tools.js";

/** Registers pi-ext-tools' static, canonical tool catalog. */
export default function piExtToolsExtension(pi: ExtensionAPI): void {
	const state = createFffRuntimeState();
	const tui = getToolTui(pi);
	registerToolTuiTrace(pi);
	const editMode = readEditMode();
	let editCatalog: EditCatalog | undefined;
	registerTools(pi, state, tui);
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools/edit-catalog",
		start(context): void {
			const resolved = resolveEditCatalog(editMode, context.extension.model);
			editCatalog = resolved;
			activateEditCatalog(context, resolved);
			context.resources.add("edit-catalog-state", () => {
				if (editCatalog === resolved) editCatalog = undefined;
			});
		},
	});
	pi.on("agent_start", (_event, ctx) => {
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
	registerApplyPatchGuard(pi);
	registerCommands(pi, { getRuntime: () => state.getRuntime() ?? null });
	registerFffLifecycle(pi, state);
}
