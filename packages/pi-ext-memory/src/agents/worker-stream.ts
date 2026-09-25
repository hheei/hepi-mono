import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export type WorkerStreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Pi 0.87's extension ModelRegistry worker streaming surface. */
export type StreamableModelRegistry = { streamSimple: WorkerStreamSimple };

/**
 * Resolve the stream function background workers must pass to `agentLoop`.
 *
 * Direct `@earendil-works/pi-ai/compat` `streamSimple` only knows built-in API
 * ids. Custom providers (`cursor-sdk`, `cliproxyapi-*`, commandcode, …) live on
 * Pi's composed runtime. Using compat after a successful foreground turn is
 * what crashes Pi with `No API provider registered for api: …` (#30).
 */
export function resolveWorkerStreamSimple(
	modelRegistry: StreamableModelRegistry,
	override?: WorkerStreamSimple,
): WorkerStreamSimple {
	if (override) return override;

	return (nextModel, context, options) => modelRegistry.streamSimple(nextModel, context, options);
}
