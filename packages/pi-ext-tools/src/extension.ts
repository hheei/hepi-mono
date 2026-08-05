import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { warmApplyPatchCoordinator } from "./apply-patch/coordinator-client.js";
import { registerApplyPatchGuard } from "./apply-patch-guard.js";
import { createFffRuntimeState, registerFffLifecycle } from "./fff/lifecycle.js";
import { registerCommands } from "./fff/register-commands.js";
import { registerTools } from "./tools.js";

/** Registers pi-ext-tools' static, canonical tool catalog. */
export default function piExtToolsExtension(pi: ExtensionAPI): void {
	const state = createFffRuntimeState();
	pi.on("agent_start", (_event, ctx) => {
		// Model streaming usually covers coordinator cold start before its first tool call.
		void warmApplyPatchCoordinator(ctx.cwd, ctx.signal).catch(() => undefined);
	});
	registerTools(pi, state);
	registerApplyPatchGuard(pi);
	registerCommands(pi, { getRuntime: () => state.getRuntime() ?? null });
	registerFffLifecycle(pi, state);
}
