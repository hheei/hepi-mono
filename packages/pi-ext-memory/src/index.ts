import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { registerStatusCommand } from "./commands/status.js";
import { registerViewCommand } from "./commands/view.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { Runtime } from "./runtime.js";
import { registerRecallTool } from "./tools/recall-observation.js";

export default function observationalMemory(pi: ExtensionAPI): void {
	const runtime = new Runtime();

	registerConsolidationTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerViewCommand(pi, runtime);
	registerRecallTool(pi);

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-memory",
		async start({ extension, signal, resources }) {
			const generation = await runtime.startSession(extension.cwd, signal);
			resources.add("observational-memory-runtime", () => {
				runtime.endSession(generation);
			});
		},
	});
}
