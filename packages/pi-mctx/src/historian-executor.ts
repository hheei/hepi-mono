import type { Api, Model } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
	type CompletionFailure,
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
const MCTX_HISTORIAN_OUTPUT_RESERVE_TOKENS = 4_096;

export interface MctxHistorianCompletionRequest {
	readonly model: Model<Api>;
	readonly source: MctxCompartmentSourceSnapshot;
	readonly sourceText: string;
	readonly signal: AbortSignal;
	readonly expectedTier?: "m0" | "m1";
}

/** Fixed prompt and output room excluded from historian source selection. */
export function mctxHistorianReservedTokens(
	source: MctxCompartmentSourceSnapshot,
	expectedTier: "m0" | "m1" | undefined,
): number {
	const prompt = createMctxHistorianPrompt({
		source,
		sourceText: "",
		...(expectedTier === undefined ? {} : { expectedTier }),
	});
	return (
		estimateTokens({ role: "user", content: MCTX_HISTORIAN_SYSTEM_PROMPT, timestamp: 0 }) +
		estimateTokens({ role: "user", content: prompt, timestamp: 0 }) +
		MCTX_HISTORIAN_OUTPUT_RESERVE_TOKENS
	);
}

export type MctxHistorianCompletionResult =
	| { readonly kind: "completed"; readonly output: string }
	| { readonly kind: "cancelled" }
	| { readonly kind: "failed"; readonly failure: CompletionFailure };

export interface MctxHistorianCompletionHandle {
	readonly result: Promise<CompletionSubagentResult>;
	cancel(): void;
}

export type MctxHistorianCompletionStarter = (
	context: ExtensionLifecycleContext,
	spec: CompletionSubagentSpec,
) => MctxHistorianCompletionHandle;

function failureFromError(error: unknown): CompletionFailure {
	return {
		kind: "invalid-request",
		message: error instanceof Error ? error.message : String(error),
	};
}

export function createMctxHistorianPrompt(
	request: Pick<MctxHistorianCompletionRequest, "source" | "sourceText" | "expectedTier">,
): string {
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
	let handle: MctxHistorianCompletionHandle;
	try {
		handle = start(context, {
			mode: "completion",
			model: request.model,
			prompt: createMctxHistorianPrompt(request),
			systemPrompt: MCTX_HISTORIAN_SYSTEM_PROMPT,
			thinkingLevel: "off",
		});
	} catch (error: unknown) {
		return { kind: "failed", failure: failureFromError(error) };
	}
	const cancel = (): void => handle.cancel();
	request.signal.addEventListener("abort", cancel, { once: true });
	try {
		const result = await handle.result;
		if (request.signal.aborted || result.status === "cancelled") return { kind: "cancelled" };
		if (result.status === "completed") return { kind: "completed", output: result.output };
		return { kind: "failed", failure: result.failure };
	} finally {
		request.signal.removeEventListener("abort", cancel);
	}
}
