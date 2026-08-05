import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryOperationsDeps } from "../operations/memory-operation-service.js";
import { createOperationCatalog } from "../operations/operation-catalog.js";
import { runHindsightSetupTui } from "./setup-tui.js";

export function registerCommands(
	pi: ExtensionAPI,
	deps: MemoryOperationsDeps,
	active: () => boolean,
	getLifecycleSignal?: () => AbortSignal | undefined,
): void {
	for (const command of createOperationCatalog(deps).commands) {
		pi.registerCommand(command.name, {
			...command.spec,
			handler: async (args, ctx) => {
				if (!active()) {
					ctx.ui.notify("Pi Hindsight is not active for this session.", "warning");
					return;
				}
				const signal = getLifecycleSignal?.();
				if (command.name === "hindsight" && signal !== undefined) {
					await runHindsightSetupTui(ctx, deps, { pi, signal });
					return;
				}
				await command.spec.handler(args, ctx);
			},
		});
	}
}
