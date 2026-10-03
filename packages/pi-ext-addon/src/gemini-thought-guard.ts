import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isGeminiModel } from "./codemode-guard.js";

/**
 * Normalizes thought signatures in Gemini conversation history:
 *
 * Upstream Gemini 2.5/3.0/3.8 models (via `@earendil-works/pi-ai`) emit thought signatures
 * on tool calls, which `convertMessages` then attaches to `functionCall` blocks. When echoed
 * back on subsequent turns with high thinking levels, Gemini's reasoning engine treats
 * `functionCall.thoughtSignature` as an unexpected or closed thought chain, causing the model
 * to terminate immediately with 0 output tokens (`finishReason: "STOP"` and empty text).
 *
 * Moving the candidate signature from `toolCall` to the corresponding `thinking` block (or
 * stripping it from `toolCall` entirely) preserves reasoning continuity without triggering
 * premature empty STOP responses.
 */
export function sanitizeGeminiThoughtSignatures(messages: readonly AgentMessage[]): AgentMessage[] {
	let modified = false;

	const result = messages.map((msg) => {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;

		let candidateSignature: string | undefined;
		let hasToolCallSignature = false;

		for (const block of msg.content) {
			if (
				block.type === "toolCall" &&
				"thoughtSignature" in block &&
				typeof block.thoughtSignature === "string" &&
				block.thoughtSignature.length > 0
			) {
				hasToolCallSignature = true;
				if (candidateSignature === undefined) {
					candidateSignature = block.thoughtSignature;
				}
			}
		}

		if (!hasToolCallSignature) return msg;
		modified = true;

		const cleanContent = (msg.content as Array<AssistantMessage["content"][number]>).map(
			(block) => {
				if (block.type === "toolCall" && "thoughtSignature" in block) {
					const { thoughtSignature: _unused, ...cleanToolCall } = block;
					return cleanToolCall;
				}
				return block;
			},
		);

		if (candidateSignature !== undefined) {
			for (let i = 0; i < cleanContent.length; i++) {
				const block = cleanContent[i];
				if (block?.type === "thinking") {
					if (!block.thinkingSignature) {
						cleanContent[i] = {
							...block,
							thinkingSignature: candidateSignature,
						};
					}
					break;
				}
			}
		}

		return {
			...msg,
			content: cleanContent,
		};
	});

	return modified ? result : (messages as AgentMessage[]);
}

export function registerGeminiThoughtGuard(pi: ExtensionAPI): void {
	pi.on("context", (event, ctx) => {
		if (!isGeminiModel(ctx?.model)) return;
		const sanitized = sanitizeGeminiThoughtSignatures(event.messages);
		if (sanitized === event.messages) return;
		return { messages: sanitized };
	});
}
