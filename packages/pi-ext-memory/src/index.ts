import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getRuntimeSettingsRegistry,
	isSubagentProcess,
	MEMORY_COMPACTOR_SERVICE_KEY,
	provideService,
	registerExtensionLifecycle,
	registerSettings,
	registerToolTuiTrace,
	setPreTurnWorkingStatus,
} from "@hheei/pi-ext-core";
import { registerOmCommand } from "./commands/om.js";
import { transformHindsightMarkdown } from "./hindsight/markdown.js";
import { type HindsightSession, startHindsightSession } from "./hindsight/session.js";
import { declareHindsightTools } from "./hindsight/tools.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import {
	registerCompactionTrigger,
	scheduleColdResumeCompaction,
} from "./hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { createMemoryInfo } from "./info.js";
import { Runtime } from "./runtime.js";
import {
	countSourceEntriesAfterCompaction,
	type Entry,
	foldLedger,
	latestGateEnabled,
} from "./session-ledger/index.js";
import { renderSummary } from "./session-ledger/render-summary.js";
import { createMemorySettingsProvider } from "./settings.js";
import { registerRecallTool } from "./tools/recall-observation.js";

export default function observationalMemory(pi: ExtensionAPI): void {
	registerToolTuiTrace(pi);
	const runtime = new Runtime();
	// Hindsight tools follow the session that is running: they resolve their state through this
	// holder, and a session declares them `deferred` or `hidden` according to its own option.
	let hindsight: HindsightSession | undefined;

	registerConsolidationTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerOmCommand(pi, runtime);
	registerRecallTool(pi);
	if (typeof pi.registerMarkdownTransformer === "function") {
		pi.registerMarkdownTransformer(transformHindsightMarkdown);
	}
	const info = createMemoryInfo(pi);

	pi.on("before_agent_start", async (event, ctx) => {
		if (hindsight === undefined || isSubagentProcess()) return;
		const stopWorkingStatus = setPreTurnWorkingStatus("Recalling");
		ctx?.ui?.setWorkingMessage?.("Recalling");
		try {
			const injected = await hindsight.beforeAgentStart(event);
			if (injected === undefined) return;
			info(injected.summary, {
				pages: injected.pages.map(({ pageId, page, snippet }) => ({ pageId, page, snippet })),
				truncated: injected.truncated,
			});
		} finally {
			stopWorkingStatus();
			ctx?.ui?.setWorkingMessage?.(undefined);
		}
	});
	pi.on("agent_end", async (event, context) => {
		if (isSubagentProcess()) return;
		hindsight?.agentEnd(event, context);
	});

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-memory",
		async start(context) {
			const { extension, signal, resources } = context;
			const generation = await runtime.startSession(extension.cwd, signal);
			resources.add("observational-memory-runtime", () => {
				runtime.endSession(generation);
			});
			scheduleColdResumeCompaction(extension, runtime);

			provideService(context, MEMORY_COMPACTOR_SERVICE_KEY, {
				createCompactionDraft(firstKeptEntryId) {
					const branch = extension.sessionManager.getBranch() as Entry[];
					if (!latestGateEnabled(branch) || runtime.compactInFlight || runtime.compactHookInFlight)
						return undefined;
					if (countSourceEntriesAfterCompaction(branch) === 0) return undefined;
					const folded = foldLedger(branch);
					if (folded.activeObservations.length === 0 && folded.activeReflections.length === 0)
						return undefined;
					const summary = renderSummary(folded.activeReflections, folded.activeObservations);
					return summary ? { summary, firstKeptEntryId } : undefined;
				},
			});

			const settingsRegistry = getRuntimeSettingsRegistry(pi);
			const configuredModelRef = runtime.config.model
				? `${runtime.config.model.provider}/${runtime.config.model.id}`
				: undefined;
			const settingsProvider = createMemorySettingsProvider({
				modelRegistry: extension.modelRegistry,
				configuredModel: configuredModelRef,
				onSaved: async () => {
					await runtime.reloadConfig(extension.cwd);
				},
			});
			resources.add("pi-ext-memory-settings", registerSettings(settingsProvider, settingsRegistry));

			const isSub = isSubagentProcess();
			const started = isSub
				? { status: "disabled" as const }
				: await startHindsightSession(extension.cwd, signal);
			const toolProvider = (): ReturnType<HindsightSession["toolContext"]> | undefined =>
				hindsight?.toolContext();
			if (started.status !== "ready") {
				if (started.status === "error" && !isSub) {
					extension.ui.notify(`Hindsight memory: ${started.error}`, "warning");
				}
				// Pi cannot unregister a tool, so a session that cannot use Hindsight withdraws the
				// tools an earlier session declared instead of leaving them reachable but refusing.
				declareHindsightTools(pi, toolProvider, "hidden");
				return;
			}

			declareHindsightTools(pi, toolProvider, "deferred");
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
