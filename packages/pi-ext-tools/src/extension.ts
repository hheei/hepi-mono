import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApplyPatchGuard } from "./apply-patch-guard.js";
import { createFffRuntimeState, registerFffLifecycle } from "./fff/lifecycle.js";
import { registerCommands } from "./fff/register-commands.js";
import { registerTools } from "./tools.js";

/** Registers pi-ext-tools' static, canonical tool catalog. */
export default function piExtToolsExtension(pi: ExtensionAPI): void {
	const state = createFffRuntimeState();
	registerTools(pi, state);
	registerApplyPatchGuard(pi);
	registerCommands(pi, { getRuntime: () => state.getRuntime() ?? null });
	registerFffLifecycle(pi, state);
}
