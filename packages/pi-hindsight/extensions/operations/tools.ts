import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import type { MemoryOperationsDeps } from "./memory-operation-service.js";
import { createOperationCatalog } from "./operation-catalog.js";

export function registerTools(pi: ExtensionAPI, deps: MemoryOperationsDeps): void {
	for (const tool of createOperationCatalog(deps).tools) {
		registerManagedLoadoutTool(
			pi,
			{
				id: tool.name,
				owner: "@hheei/pi-hindsight",
				group: "Memory",
				priority: 0,
				conflictSets: [],
				defaultActive: true,
			},
			tool,
		);
	}
}
