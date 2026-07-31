import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { createMctxFeature } from "./feature.js";

interface PiContextHook {
	on(
		event: "context",
		handler: (
			event: { readonly messages: readonly AgentMessage[] },
			context: ExtensionContext,
		) => { readonly messages: readonly AgentMessage[] } | undefined,
	): void;
}

function registerContextHook(
	pi: ExtensionAPI,
	feature: ReturnType<typeof createMctxFeature>,
): void {
	// Pi exposes this runtime hook, but the installed public extension declaration omits it.
	const hooks = pi as unknown as PiContextHook;
	hooks.on("context", (event, context) => feature.onContext(event.messages, context));
}

/**
 * Pi package entry. `turn_end` schedules historian work in the background;
 * context transformation remains unregistered.
 */
export default function piMctxExtension(pi: ExtensionAPI): void {
	const feature = createMctxFeature();
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-mctx",
		start: feature.start,
	});
	registerContextHook(pi, feature);
	pi.on("turn_end", (_event, context) => feature.onTurnEnd(context));
}
