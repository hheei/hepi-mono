import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	HepiLifecycleController,
	registerHepiLifecycle,
} from "../../../hepi-basics/src/core/index.js";
import { createFffAutocompleteProvider } from "./autocomplete.js";
import {
	ALL_FEATURE_KEYS,
	type FeatureKey,
	loadGlobalFeatureStateSync,
	saveGlobalFeatureState,
} from "./extension-common.js";
import { FffRuntime } from "./fff.js";
import { registerCommands } from "./register-commands.js";
import { registerTools } from "./register-tools.js";

export type FffRegistrationOptions = {
	readonly registerRead?: boolean;
};

export default function registerHepiFff(
	pi: ExtensionAPI,
	options: FffRegistrationOptions = {},
): void {
	let runtime: FffRuntime | undefined;
	let enabledFeatures = new Set<FeatureKey>(ALL_FEATURE_KEYS);
	const autocompleteContexts = new WeakSet<object>();
	const initialFeatureState = loadGlobalFeatureStateSync();
	if (initialFeatureState.isOk())
		enabledFeatures = new Set(initialFeatureState.value ?? ALL_FEATURE_KEYS);
	else
		console.warn(
			"Failed to restore HEPI FFF feature state during extension load:",
			initialFeatureState.error,
		);

	const isFeatureEnabled = (feature: FeatureKey): boolean => enabledFeatures.has(feature);
	const getRuntime = (): FffRuntime | null => runtime ?? null;
	const getEnabledFeatures = (): Set<FeatureKey> => new Set(enabledFeatures);
	const applyUiConfiguration = (ctx: ExtensionContext): void => {
		if (isFeatureEnabled("autocomplete") && !autocompleteContexts.has(ctx)) {
			autocompleteContexts.add(ctx);
			ctx.ui.addAutocompleteProvider((baseProvider) =>
				createFffAutocompleteProvider(
					baseProvider,
					() => runtime,
					() => isFeatureEnabled("autocomplete"),
				),
			);
		}
	};
	const persistFeatures = async (next: Set<FeatureKey>): Promise<void> => {
		const saved = await saveGlobalFeatureState(next);
		if (saved.isErr()) console.error("Failed to save HEPI FFF feature state:", saved.error);
	};
	const agentToolsDisabledText = (): string =>
		'HEPI FFF feature "agent tools" is disabled. Use /fff-features to re-enable it.';

	registerTools(
		pi,
		{
			getRuntime,
			isFeatureEnabled,
			agentToolsDisabledText,
		},
		options,
	);
	registerCommands(pi, {
		getRuntime,
		isFeatureEnabled,
		getEnabledFeatures,
		persistFeatures,
	});

	const lifecycle = new HepiLifecycleController({
		onStart: async (session) => {
			runtime?.dispose();
			runtime = new FffRuntime(session.ctx.cwd);
			const activeRuntime = runtime;
			session.registry.registerLifecycle({
				id: "fff-runtime",
				cleanup: () => {
					activeRuntime.dispose();
					if (runtime === activeRuntime) runtime = undefined;
				},
			});
			applyUiConfiguration(session.ctx);
			void (async (): Promise<void> => {
				const warmed = await activeRuntime.warm(1500);
				if (runtime !== activeRuntime) return;
				if (warmed.isErr()) {
					if (isFeatureEnabled("statusUI"))
						session.ctx.ui.notify(`fff unavailable: ${warmed.error.message}`, "warning");
					return;
				}
				if (isFeatureEnabled("statusUI")) {
					const indexed = warmed.value.indexedFiles ? ` (${warmed.value.indexedFiles} files)` : "";
					session.ctx.ui.notify(`fff path + grep mode enabled${indexed}`, "info");
				}
			})();
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-fff");
}
