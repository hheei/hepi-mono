import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import { type MctxRuntime, resolveMctxActivation } from "./activation.js";
import {
	defaultMctxSettingsPaths,
	loadMctxConfiguration,
	type MctxConfiguration,
} from "./config.js";
import { createProjectIdentityResolver } from "./project-identity.js";
import {
	defaultMctxStorePath,
	type MctxPartition,
	type MctxStore,
	openMctxStore,
} from "./store.js";

export interface MctxSessionRuntime extends MctxRuntime {
	readonly store: MctxStore;
	readonly partition: MctxPartition;
}

export interface MctxFeature {
	start(context: ExtensionLifecycleContext): Promise<void>;
	active(): MctxSessionRuntime | undefined;
}

export interface MctxFeatureOptions {
	readonly loadConfiguration?: (
		paths: ReturnType<typeof defaultMctxSettingsPaths>,
		signal: AbortSignal,
	) => Promise<MctxConfiguration>;
	readonly openStore?: (path: string) => MctxStore | Promise<MctxStore>;
	readonly resolveProjectIdentity?: (cwd: string, signal: AbortSignal) => Promise<string>;
}

/** Owns the session runtime holder; future store and context work attach here. */
export function createMctxFeature(options: MctxFeatureOptions = {}): MctxFeature {
	const loadConfiguration = options.loadConfiguration ?? loadMctxConfiguration;
	const openStore = options.openStore ?? openMctxStore;
	const identityResolver = createProjectIdentityResolver();
	const resolveProjectIdentity = options.resolveProjectIdentity ?? identityResolver.resolve;
	let active: MctxSessionRuntime | undefined;
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
			active = runtime;
			context.resources.add("mctx-runtime", () => {
				store.close();
				if (active === runtime) active = undefined;
			});
		},
		active: (): MctxSessionRuntime | undefined => active,
	};
}
