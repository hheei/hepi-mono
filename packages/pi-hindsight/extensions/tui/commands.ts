import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryOperationsDeps } from "../operations/memory-operation-service.js";
import { createOperationCatalog } from "../operations/operation-catalog.js";

export function registerCommands(
	pi: ExtensionAPI,
	deps: MemoryOperationsDeps,
	active: () => boolean,
): void {
	for (const command of createOperationCatalog(deps).commands) {
		pi.registerCommand(command.name, {
			...command.spec,
			handler: async (args, ctx) => {
				if (!active()) {
					ctx.ui.notify("Pi Hindsight is not active for this session.", "warning");
					return;
				}
				await command.spec.handler(args, ctx);
			},
		});
	}
}
