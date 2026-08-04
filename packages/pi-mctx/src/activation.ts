import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionLifecycleContext, ensureSubagentCoordinator } from "@hheei/pi-ext-core";
import type { MctxConfiguration, MctxPipelineSettings, MctxSearchSettings } from "./config.js";

export type MctxHistorianRuntime =
	| { readonly kind: "disabled" }
	| { readonly kind: "unavailable"; readonly diagnostic: string }
	| { readonly kind: "active"; readonly model: Model<Api> };

/** Resolved immutable inputs held for one active parent session. */
export interface MctxRuntime {
	readonly cwd: string;
	readonly sessionId: string;
	readonly historian: MctxHistorianRuntime;
	readonly settings: MctxPipelineSettings;
	readonly search: MctxSearchSettings;
	/** User-owned Dreamer child model ref; absent means the parent model. */
	readonly dreamerModel?: string;
}

function resolveHistorian(
	context: ExtensionLifecycleContext,
	settings: MctxPipelineSettings,
): MctxHistorianRuntime {
	switch (settings.historian.kind) {
		case "disabled":
			return { kind: "disabled" };
		case "invalid":
			return {
				kind: "unavailable",
				diagnostic: `pi-mctx historian configuration is invalid: ${settings.historian.reason}`,
			};
		case "enabled": {
			const parts = modelParts(settings.historian.model);
			if (!parts) {
				return {
					kind: "unavailable",
					diagnostic: "pi-mctx historian model must be exact provider/model",
				};
			}
			const model = context.extension.modelRegistry.find(parts.provider, parts.model);
			if (!model || !context.extension.modelRegistry.hasConfiguredAuth(model)) {
				return {
					kind: "unavailable",
					diagnostic: `pi-mctx historian model is unavailable: ${settings.historian.model}`,
				};
			}
			try {
				ensureSubagentCoordinator(context);
				return { kind: "active", model };
			} catch (error: unknown) {
				return {
					kind: "unavailable",
					diagnostic: `pi-mctx historian coordinator unavailable: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
	}
}

export type MctxActivation =
	| { readonly kind: "inactive"; readonly reason: "disabled" }
	| { readonly kind: "inactive"; readonly reason: "invalid"; readonly diagnostic: string }
	| { readonly kind: "inactive"; readonly reason: "unavailable"; readonly diagnostic: string }
	| { readonly kind: "active"; readonly runtime: MctxRuntime };

function modelParts(
	modelRef: string,
): { readonly provider: string; readonly model: string } | undefined {
	const parts = modelRef.split("/");
	const provider = parts[0];
	const model = parts[1];
	return parts.length === 2 && provider && model ? { provider, model } : undefined;
}

/**
 * Resolves the session's historian without opening the store or changing model
 * context. The caller owns diagnostics and the returned runtime holder.
 */
export function resolveMctxActivation(
	context: ExtensionLifecycleContext,
	configuration: MctxConfiguration,
): MctxActivation {
	switch (configuration.pipeline.kind) {
		case "disabled":
			return { kind: "inactive", reason: "disabled" };
		case "invalid":
			return {
				kind: "inactive",
				reason: "invalid",
				diagnostic: `pi-mctx configuration is invalid: ${configuration.pipeline.reason}`,
			};
		case "enabled": {
			return {
				kind: "active",
				runtime: {
					cwd: context.extension.cwd,
					sessionId: context.extension.sessionManager.getSessionId(),
					historian: resolveHistorian(context, configuration.pipeline.settings),
					settings: configuration.pipeline.settings,
					search: configuration.search ?? {},
					...(configuration.dreamer?.model === undefined
						? {}
						: { dreamerModel: configuration.dreamer.model }),
				},
			};
		}
	}
}
