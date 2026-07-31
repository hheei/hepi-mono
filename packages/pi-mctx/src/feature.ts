import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import { type MctxRuntime, resolveMctxActivation } from "./activation.js";
import { planMctxCompartmentRecovery } from "./compartment-graph.js";
import {
	defaultMctxSettingsPaths,
	loadMctxConfiguration,
	type MctxConfiguration,
} from "./config.js";
import { projectMctxContext } from "./context-projection.js";
import { runMctxHistorianForBranch } from "./historian-branch-runner.js";
import { createProjectIdentityResolver } from "./project-identity.js";
import {
	defaultMctxStorePath,
	type MctxPartition,
	type MctxStore,
	openMctxStore,
} from "./store.js";
import { evaluateMctxTriggerPolicy } from "./trigger-policy.js";

/** Active session state. `partition` is replaced after each successful store CAS. */
export interface MctxSessionRuntime extends MctxRuntime {
	readonly store: MctxStore;
	readonly partition: MctxPartition;
}

/**
 * Pi-facing lifecycle seam. `onTurnEnd` only starts detached work; `onContext`
 * is synchronous and fails open when its branch proof no longer matches.
 */
export interface MctxFeature {
	start(context: ExtensionLifecycleContext): Promise<void>;
	onTurnEnd(context: ExtensionContext): void;
	onContext(
		messages: readonly AgentMessage[],
		context: ExtensionContext,
	): { readonly messages: readonly AgentMessage[] } | undefined;
	active(): MctxSessionRuntime | undefined;
}

/** Dependency seams for focused tests; production uses the MCTX-owned defaults. */
export interface MctxFeatureOptions {
	readonly loadConfiguration?: (
		paths: ReturnType<typeof defaultMctxSettingsPaths>,
		signal: AbortSignal,
	) => Promise<MctxConfiguration>;
	readonly openStore?: (path: string) => MctxStore | Promise<MctxStore>;
	readonly resolveProjectIdentity?: (cwd: string, signal: AbortSignal) => Promise<string>;
	readonly runHistorianForBranch?: typeof runMctxHistorianForBranch;
}

interface ActiveMctxRuntime {
	runtime: MctxSessionRuntime;
	readonly lifecycle: ExtensionLifecycleContext;
	cooling: boolean;
	job?: AbortController | undefined;
	rebuildEntries?: readonly SessionEntry[] | undefined;
}

function modelThreshold(
	threshold: { readonly defaultValue?: number; readonly byModel: Readonly<Record<string, number>> },
	model: ExtensionContext["model"],
): number | undefined {
	if (model === undefined) return threshold.defaultValue;
	return threshold.byModel[`${model.provider}/${model.id}`] ?? threshold.defaultValue;
}

/** Owns the session runtime holder; future store and context work attach here. */
export function createMctxFeature(options: MctxFeatureOptions = {}): MctxFeature {
	const loadConfiguration = options.loadConfiguration ?? loadMctxConfiguration;
	const openStore = options.openStore ?? openMctxStore;
	const identityResolver = createProjectIdentityResolver();
	const resolveProjectIdentity = options.resolveProjectIdentity ?? identityResolver.resolve;
	const runHistorianForBranch = options.runHistorianForBranch ?? runMctxHistorianForBranch;
	let active: ActiveMctxRuntime | undefined;
	/**
	 * Serializes historian work per session. A replacement branch is retained as
	 * `rebuildEntries` until the aborted job terminalizes, preventing overlapping
	 * writers while allowing the latest branch to be rebuilt promptly.
	 */
	function startHistorian(current: ActiveMctxRuntime, entries: readonly SessionEntry[]): void {
		if (current.job !== undefined || current.lifecycle.signal.aborted) return;
		const job = new AbortController();
		current.job = job;
		const abort = (): void => job.abort();
		current.lifecycle.signal.addEventListener("abort", abort, { once: true });
		void runHistorianForBranch({
			context: current.lifecycle,
			model: current.runtime.historian,
			store: current.runtime.store,
			partition: current.runtime.partition,
			entries,
			signal: job.signal,
		})
			.then((result) => {
				if (
					result.kind === "published" &&
					active === current &&
					current.job === job &&
					!job.signal.aborted
				) {
					current.runtime = { ...current.runtime, partition: result.publication.partition };
				}
			})
			.catch((error: unknown) => {
				if (!job.signal.aborted) {
					current.lifecycle.extension.ui.notify(
						`pi-mctx historian failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
			})
			.finally(() => {
				current.lifecycle.signal.removeEventListener("abort", abort);
				if (current.job !== job) return;
				current.job = undefined;
				const rebuildEntries = current.rebuildEntries;
				current.rebuildEntries = undefined;
				if (
					rebuildEntries !== undefined &&
					active === current &&
					!current.lifecycle.signal.aborted
				) {
					startHistorian(current, rebuildEntries);
				}
			});
	}
	return {
		async start(context): Promise<void> {
			let configuration: MctxConfiguration;
			try {
				configuration = await loadConfiguration(
					defaultMctxSettingsPaths(context.extension.cwd),
					context.signal,
				);
			} catch (error: unknown) {
				if (!context.signal.aborted) {
					context.extension.ui.notify(
						`pi-mctx configuration unavailable: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
				return;
			}
			if (context.signal.aborted) return;

			const activation = resolveMctxActivation(context, configuration);
			if (activation.kind === "inactive") {
				if (activation.reason !== "disabled")
					context.extension.ui.notify(activation.diagnostic, "warning");
				return;
			}
			let store: MctxStore;
			try {
				store = await openStore(defaultMctxStorePath());
			} catch (error: unknown) {
				context.extension.ui.notify(
					`pi-mctx context store unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				throw error;
			}
			let partition: MctxPartition;
			try {
				const projectIdentity = await resolveProjectIdentity(context.extension.cwd, context.signal);
				if (context.signal.aborted) {
					store.close();
					return;
				}
				partition = store.getOrCreatePartition(projectIdentity, activation.runtime.sessionId);
			} catch (error: unknown) {
				store.close();
				if (!context.signal.aborted) {
					context.extension.ui.notify(
						`pi-mctx context partition unavailable: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				throw error;
			}
			const runtime: MctxSessionRuntime = { ...activation.runtime, store, partition };
			const current: ActiveMctxRuntime = { runtime, lifecycle: context, cooling: false };
			active = current;
			// Resource cleanup is ordered: abort the historian before closing its store.
			context.resources.add("mctx-runtime", () => {
				store.close();
				if (active === current) active = undefined;
			});
			context.resources.add("mctx-historian", () => {
				current.rebuildEntries = undefined;
				current.job?.abort();
				if (active === current) active = undefined;
			});
		},
		onTurnEnd(context): void {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return;
			const usage = context.getContextUsage();
			if (usage === undefined || typeof usage.tokens !== "number") return;
			const percentage = modelThreshold(
				current.runtime.settings.executeThresholdPercentage,
				context.model,
			);
			if (percentage === undefined) return;
			const absolute =
				current.runtime.settings.executeThresholdTokens === undefined
					? undefined
					: modelThreshold(current.runtime.settings.executeThresholdTokens, context.model);
			const decision = evaluateMctxTriggerPolicy({
				usageTokens: usage.tokens,
				contextWindow: usage.contextWindow,
				percentage,
				cooling: current.cooling,
				...(absolute === undefined ? {} : { absoluteThreshold: absolute }),
			});
			current.cooling = decision.cooling;
			if (decision.kind !== "trigger" || current.job !== undefined) return;

			startHistorian(current, context.sessionManager.getBranch());
		},
		onContext(messages, context): { readonly messages: readonly AgentMessage[] } | undefined {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return undefined;
			const entries = context.sessionManager.getBranch();
			const compartments = current.runtime.store.listCompartments(current.runtime.partition);
			const recovery = planMctxCompartmentRecovery(entries, compartments);
			if (recovery.kind === "rebuild") {
				// Branch edits invalidate only the divergent publication tail. Discard via
				// CAS, then replay the newest stable entries after the job observes abort.
				const rebuildEntries = [...entries];
				const nextPartition = current.runtime.store.discardCompartmentsFrom(
					current.runtime.partition,
					recovery.discardFromRevision,
				);
				if (
					nextPartition !== undefined &&
					active === current &&
					!current.lifecycle.signal.aborted
				) {
					current.runtime = { ...current.runtime, partition: nextPartition };
					current.rebuildEntries = rebuildEntries;
					if (current.job === undefined) startHistorian(current, rebuildEntries);
					else current.job.abort();
				}
				return undefined;
			}
			if (recovery.kind !== "valid") return undefined;
			const projection = projectMctxContext(messages, entries, compartments);
			return projection.kind === "rendered" ? { messages: projection.messages } : undefined;
		},
		active: (): MctxSessionRuntime | undefined => active?.runtime,
	};
}
