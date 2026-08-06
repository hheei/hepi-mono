import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ensureKnowledgeInjectionCoordinator,
	getKnowledgeInjectionCoordinator,
	HINDSIGHT_KNOWLEDGE_PROVIDER,
	HINDSIGHT_PAGE_SECTION_SERVICE,
	type KnowledgeInjectionLease,
	provideService,
	registerExtensionLifecycle,
} from "@hheei/pi-ext-core";
import { registerHindsightSettings } from "./config/hepi-settings.js";
import { createHindsightKnowledgeProvider } from "./lifecycle/knowledge-provider.js";
import { createMemoryLifecycle } from "./lifecycle/memory-lifecycle.js";
import { createHindsightPageSectionService } from "./lifecycle/page-sections.js";
import { registerTools } from "./operations/tools.js";
import { registerCommands } from "./tui/commands.js";

export default function hindsightExtension(pi: ExtensionAPI): void {
	const lifecycle = createMemoryLifecycle(process.cwd());
	let lifecycleSignal: AbortSignal | undefined;
	let injectionLease: KnowledgeInjectionLease | undefined;
	let pageSectionService: Awaited<ReturnType<typeof createHindsightPageSectionService>> | undefined;
	const active = (): boolean => lifecycleSignal !== undefined && !lifecycleSignal.aborted;
	const canInjectAutomatically = (ctx: ExtensionContext): boolean => {
		const coordinator = getKnowledgeInjectionCoordinator(pi);
		if (coordinator === undefined) return false;
		const state = coordinator.state();
		if (state.owner === "mctx-owned" || state.owner === "disabled") return false;
		if (state.owner === "hindsight-owned") return true;
		if (state.mctxEligible) return false;
		injectionLease ??= coordinator.claim({
			owner: "hindsight-owned",
			generation: `hindsight:${ctx.sessionManager.getSessionId()}`,
			reason: "MCTX automatic knowledge integration is unavailable",
		});
		return injectionLease !== undefined;
	};

	registerTools(pi, lifecycle.deps);
	registerCommands(pi, lifecycle.deps, active, () => lifecycleSignal);

	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-hindsight",
		start: async (context) => {
			lifecycleSignal = context.signal;
			const coordinator = ensureKnowledgeInjectionCoordinator(pi, context);
			context.resources.add("hindsight-active-session", () => {
				if (lifecycleSignal === context.signal) lifecycleSignal = undefined;
				if (injectionLease !== undefined) {
					coordinator.release(injectionLease);
					injectionLease = undefined;
				}
			});
			// Register before startup so a failed bank initialization still stops timers and flushes safely.
			context.resources.add("hindsight-memory-lifecycle", () =>
				lifecycle.shutdown(context.extension),
			);
			context.resources.add("hindsight-settings", registerHindsightSettings(pi));
			await lifecycle.initialize(context.extension, context.signal);
			const config = lifecycle.deps.getConfig();
			if (config.enabled && config.setupComplete && config.banks.project.enabled) {
				provideService(
					context,
					HINDSIGHT_KNOWLEDGE_PROVIDER,
					createHindsightKnowledgeProvider({
						getClient: lifecycle.deps.getClient,
						getConfig: lifecycle.deps.getConfig,
						getProjectBankId: lifecycle.deps.getProjectBankId,
						getCwd: () => context.extension.cwd,
					}),
				);
				pageSectionService = await createHindsightPageSectionService(
					{
						getClient: lifecycle.deps.getClient,
						getConfig: lifecycle.deps.getConfig,
						getProjectBankId: lifecycle.deps.getProjectBankId,
						getCwd: () => context.extension.cwd,
						getInjectionState: () => coordinator.state(),
					},
					context.signal,
				);
				if (pageSectionService !== undefined) {
					provideService(context, HINDSIGHT_PAGE_SECTION_SERVICE, pageSectionService.service);
					context.resources.add("hindsight-page-section-service", () => {
						pageSectionService = undefined;
					});
				}
			}
		},
	});

	// Pi retains raw handlers across reload. The session signal makes older module instances inert.
	pi.on("context", async (event, ctx) =>
		active() && canInjectAutomatically(ctx)
			? lifecycle.recall(event, ctx, lifecycleSignal)
			: undefined,
	);

	pi.on("agent_end", async (event, ctx) => {
		if (!active()) return;
		await lifecycle.retain(event, ctx, lifecycleSignal);
		const refresh = pageSectionService?.refresh;
		const signal = lifecycleSignal;
		if (refresh !== undefined && signal !== undefined) void refresh(signal).catch(() => undefined);
	});
}
