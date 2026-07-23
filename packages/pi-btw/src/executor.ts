import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { extractAssistantText } from "./model.js";
import { BTW_SYSTEM_PROMPT } from "./prompt.js";

export type BtwExecutionResult =
	| { readonly status: "success"; readonly response: AssistantMessage; readonly text: string }
	| { readonly status: "aborted" }
	| { readonly status: "error"; readonly message: string };

export interface ExecuteBtwTurnOptions {
	readonly model: Model<Api>;
	readonly modelRegistry: ModelRegistry;
	readonly messages: Context["messages"];
	readonly signal: AbortSignal;
	readonly complete?: typeof completeSimple;
}

function errorText(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) return error.message;
	return "The BTW request failed";
}

function createCompletionOptions(
	signal: AbortSignal,
	auth: {
		readonly apiKey?: string;
		readonly headers?: ProviderHeaders;
		readonly env?: ProviderEnv;
	},
): SimpleStreamOptions {
	return {
		signal,
		...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
		...(auth.headers === undefined ? {} : { headers: auth.headers }),
		...(auth.env === undefined ? {} : { env: auth.env }),
	};
}

export async function executeBtwTurn(options: ExecuteBtwTurnOptions): Promise<BtwExecutionResult> {
	if (options.signal.aborted) return { status: "aborted" };
	if (!options.modelRegistry.hasConfiguredAuth(options.model)) {
		return {
			status: "error",
			message: `No credentials are configured for ${options.model.provider}`,
		};
	}
	const auth = await options.modelRegistry.getApiKeyAndHeaders(options.model);
	if (!auth.ok) return { status: "error", message: auth.error };
	if (options.signal.aborted) return { status: "aborted" };

	try {
		const response = await (options.complete ?? completeSimple)(
			options.model,
			{ systemPrompt: BTW_SYSTEM_PROMPT, messages: [...options.messages], tools: [] },
			createCompletionOptions(options.signal, auth),
		);
		if (options.signal.aborted || response.stopReason === "aborted") return { status: "aborted" };
		if (response.stopReason !== "stop") {
			return {
				status: "error",
				message:
					response.errorMessage?.trim() ||
					`BTW response ended with stop reason ${response.stopReason}`,
			};
		}
		const text = extractAssistantText(response);
		if (!text) return { status: "error", message: "The model returned an empty BTW response" };
		return { status: "success", response, text };
	} catch (error: unknown) {
		if (options.signal.aborted) return { status: "aborted" };
		return { status: "error", message: errorText(error) };
	}
}
