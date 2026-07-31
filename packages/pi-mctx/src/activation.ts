import type { Api, Model } from "@earendil-works/pi-ai";
import { configureSubagentCoordinator, type ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import type { MctxConfiguration, MctxPipelineSettings } from "./config.js";

export interface MctxRuntime {
	readonly sessionId: string;
	readonly historian: Model<Api>;
	readonly settings: MctxPipelineSettings;
}

export type MctxActivation =
	| { readonly kind: "inactive"; readonly reason: "disabled" }
	| { readonly kind: "inactive"; readonly reason: "invalid"; readonly diagnostic: string }
	| { readonly kind: "inactive"; readonly reason: "unavailable"; readonly diagnostic: string }
	| { readonly kind: "inactive"; readonly reason: "collision"; readonly diagnostic: string }
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
			const parts = modelParts(configuration.pipeline.settings.historianModel);
			if (!parts) {
				return {
					kind: "inactive",
					reason: "invalid",
					diagnostic: "pi-mctx historian model must be exact provider/model",
				};
			}
			const historian = context.extension.modelRegistry.find(parts.provider, parts.model);
			if (!historian || !context.extension.modelRegistry.hasConfiguredAuth(historian)) {
				return {
					kind: "inactive",
					reason: "unavailable",
					diagnostic: `pi-mctx historian model is unavailable: ${configuration.pipeline.settings.historianModel}`,
				};
			}
			try {
				configureSubagentCoordinator(context, { maxActiveTurns: 2 });
			} catch (error: unknown) {
				return {
					kind: "inactive",
					reason: "collision",
					diagnostic: `pi-mctx activation blocked: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			return {
				kind: "active",
				runtime: {
					sessionId: context.extension.sessionManager.getSessionId(),
					historian,
					settings: configuration.pipeline.settings,
				},
			};
		}
	}
}
