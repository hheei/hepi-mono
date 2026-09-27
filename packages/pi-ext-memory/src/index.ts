import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { registerOmCommand } from "./commands/om.js";
import { type HindsightSession, startHindsightSession } from "./hindsight/session.js";
import { registerHindsightTools, setHindsightToolsActive } from "./hindsight/tools.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import {
	registerCompactionTrigger,
	scheduleColdResumeCompaction,
} from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { Runtime } from "./runtime.js";
import { registerRecallTool } from "./tools/recall-observation.js";

export default function observationalMemory(pi: ExtensionAPI): void {
	const runtime = new Runtime();
	// Hindsight tools are registered once per Pi process but must always act on the session
	// that is currently running, so they resolve their state through this holder.
	let hindsight: HindsightSession | undefined;
	let hindsightRegistered = false;

	registerConsolidationTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerOmCommand(pi, runtime);
	registerRecallTool(pi);

	pi.on("before_agent_start", async (event) => {
		if (hindsight === undefined) return;
		return hindsight.beforeAgentStart(event);
	});
	pi.on("agent_end", async (event, context) => {
		hindsight?.agentEnd(event, context);
	});

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-memory",
		async start({ extension, signal, resources }) {
			const generation = await runtime.startSession(extension.cwd, signal);
			resources.add("observational-memory-runtime", () => {
				runtime.endSession(generation);
			});
			scheduleColdResumeCompaction(extension, runtime);

			const started = await startHindsightSession(extension.cwd, signal);
			if (started.status !== "ready") {
				if (started.status === "error") {
					extension.ui.notify(`Hindsight memory: ${started.error}`, "warning");
				}
				// A session that starts with the option off must not leave an earlier
				// session's tools reachable.
				setHindsightToolsActive({ pi, extension, signal, resources }, false);
				return;
			}

			if (!hindsightRegistered) {
				registerHindsightTools(pi, () => hindsight?.toolContext());
				hindsightRegistered = true;
			}
			const session = started.session;
			hindsight = session;
			// Registered last so it is torn down first: the pending session writeback is
			// flushed before the memory runtime it reports through is released.
			resources.add("hindsight-session", () => {
				if (hindsight === session) hindsight = undefined;
				return session.dispose();
			});
		},
	});
}
