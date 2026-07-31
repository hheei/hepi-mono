import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import { type MctxRuntime, resolveMctxActivation } from "./activation.js";
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

export interface MctxSessionRuntime extends MctxRuntime {
	readonly store: MctxStore;
	readonly partition: MctxPartition;
}

export interface MctxFeature {
	start(context: ExtensionLifecycleContext): Promise<void>;
	onTurnEnd(context: ExtensionContext): void;
	onContext(
		messages: readonly AgentMessage[],
		context: ExtensionContext,
	): { readonly messages: readonly AgentMessage[] } | undefined;
	active(): MctxSessionRuntime | undefined;
}

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
			context.resources.add("mctx-runtime", () => {
				store.close();
				if (active === current) active = undefined;
			});
			context.resources.add("mctx-historian", () => {
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

			const job = new AbortController();
			current.job = job;
			const abort = (): void => job.abort();
			current.lifecycle.signal.addEventListener("abort", abort, { once: true });
			void runHistorianForBranch({
				context: current.lifecycle,
				model: current.runtime.historian,
				store: current.runtime.store,
				partition: current.runtime.partition,
				entries: context.sessionManager.getBranch(),
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
						context.ui.notify(
							`pi-mctx historian failed: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					}
				})
				.finally(() => {
					current.lifecycle.signal.removeEventListener("abort", abort);
					if (current.job === job) current.job = undefined;
				});
		},
		onContext(messages, context): { readonly messages: readonly AgentMessage[] } | undefined {
			const current = active;
			if (
				current === undefined ||
				current.lifecycle.signal.aborted ||
				current.runtime.sessionId !== context.sessionManager.getSessionId()
			)
				return undefined;
			const projection = projectMctxContext(
				messages,
				context.sessionManager.getBranch(),
				current.runtime.store.listCompartments(current.runtime.partition),
			);
			return projection.kind === "rendered" ? { messages: projection.messages } : undefined;
		},
		active: (): MctxSessionRuntime | undefined => active?.runtime,
	};
}
