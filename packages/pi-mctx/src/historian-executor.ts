import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type CompletionSubagentResult,
	type CompletionSubagentSpec,
	type ExtensionLifecycleContext,
	startSubagent,
} from "@hheei/pi-ext-core";
import type { MctxCompartmentSourceSnapshot } from "./compartment-validation.js";

export const MCTX_HISTORIAN_SYSTEM_PROMPT = `You compress one bounded source range into a MCTX compartment.
Return exactly one JSON object. Do not use Markdown or code fences.
Use only the source entry IDs supplied in the user prompt.
The object must have exactly these keys: tier, sourceStartEntryId, sourceEndEntryId, renderedPayload.`;

export interface MctxHistorianCompletionRequest {
	readonly model: Model<Api>;
	readonly source: MctxCompartmentSourceSnapshot;
	readonly sourceText: string;
	readonly signal: AbortSignal;
	readonly expectedTier?: "m0" | "m1";
}

export type MctxHistorianCompletionResult =
	| { readonly kind: "completed"; readonly output: string }
	| { readonly kind: "cancelled" }
	| { readonly kind: "failed"; readonly reason: string };

export interface MctxHistorianCompletionHandle {
	readonly result: Promise<CompletionSubagentResult>;
	cancel(): void;
}

export type MctxHistorianCompletionStarter = (
	context: ExtensionLifecycleContext,
	spec: CompletionSubagentSpec,
) => MctxHistorianCompletionHandle;

export function createMctxHistorianPrompt(request: MctxHistorianCompletionRequest): string {
	const tier = request.expectedTier === undefined ? "" : `Required tier: ${request.expectedTier}\n`;
	return `${tier}Source fingerprint: ${request.source.fingerprint}
Source entry IDs, in order: ${JSON.stringify(request.source.entryIds)}

Source history:
${request.sourceText}`;
}

/** Runs one no-tools historian completion; retries and storage remain caller-owned. */
export async function executeMctxHistorianCompletion(
	context: ExtensionLifecycleContext,
	request: MctxHistorianCompletionRequest,
	start: MctxHistorianCompletionStarter = startSubagent,
): Promise<MctxHistorianCompletionResult> {
	if (request.signal.aborted) return { kind: "cancelled" };
	const handle = start(context, {
		mode: "completion",
		model: request.model,
		prompt: createMctxHistorianPrompt(request),
		systemPrompt: MCTX_HISTORIAN_SYSTEM_PROMPT,
		thinkingLevel: "off",
	});
	const cancel = (): void => handle.cancel();
	request.signal.addEventListener("abort", cancel, { once: true });
	try {
		const result = await handle.result;
		if (request.signal.aborted || result.status === "cancelled") return { kind: "cancelled" };
		if (result.status === "completed") return { kind: "completed", output: result.output };
		return { kind: "failed", reason: result.failure ?? "Historian completion failed" };
	} finally {
		request.signal.removeEventListener("abort", cancel);
	}
}
