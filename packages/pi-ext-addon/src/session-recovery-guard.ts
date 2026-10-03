import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
	AgentBeforeSettleEventResult,
	ExtensionAPI,
	SessionBoundaryDraft,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { getService, MEMORY_COMPACTOR_SERVICE_KEY } from "@hheei/pi-ext-core";

export const RECOVERY_ERROR_409_PATTERN = /409|request_rejected|当前会话不可用|请新开会话/i;

export function is409SessionError(errorText: string | undefined): boolean {
	return errorText ? RECOVERY_ERROR_409_PATTERN.test(errorText) : false;
}

export function isGptModel(model: Model<Api> | undefined): boolean {
	if (!model) return false;
	const ref =
		`${model.provider ?? ""} ${model.id ?? ""} ${model.name ?? ""} ${typeof model.api === "string" ? model.api : ""}`.toLowerCase();
	return ref.includes("gpt") || ref.includes("openai") || ref.includes("azure");
}

/**
 * Strips encrypted thinking blocks from assistant messages, falling back to a text
 * placeholder if the message would otherwise have empty content.
 */
export function stripEncryptedThinking(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((msg) => {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;
		const clean = (msg.content as Array<AssistantMessage["content"][number]>).filter(
			(b) => b.type !== "thinking",
		);
		if (clean.length === msg.content.length) return msg;
		return {
			...msg,
			content: clean.length > 0 ? clean : [{ type: "text" as const, text: "(thinking omitted)" }],
		};
	});
}

function scanLastMessageEntries(branch: readonly SessionEntry[]): {
	lastAssistant: { id: string; message: AssistantMessage } | undefined;
	lastUserEntryId: string | undefined;
} {
	let lastAssistant: { id: string; message: AssistantMessage } | undefined;
	let lastUserEntryId: string | undefined;
	for (let i = branch.length - 1; i >= 0 && (!lastAssistant || !lastUserEntryId); i--) {
		const entry = branch[i];
		if (!lastAssistant && entry?.type === "message" && entry.message?.role === "assistant") {
			lastAssistant = { id: entry.id, message: entry.message as AssistantMessage };
		} else if (!lastUserEntryId && entry?.type === "message" && entry.message?.role === "user") {
			lastUserEntryId = entry.id;
		}
	}
	return { lastAssistant, lastUserEntryId };
}

export interface SessionRecoveryGuard {
	readonly isThinkingStripped: () => boolean;
	readonly reset: () => void;
}

export function registerSessionRecoveryGuard(pi: ExtensionAPI): SessionRecoveryGuard {
	let thinkingStripped = false;
	let retryCount = 0;

	const reset = (): void => {
		thinkingStripped = false;
		retryCount = 0;
	};

	pi.on("session_start", reset);
	pi.on("session_before_switch", reset);

	pi.on("context", (event) => {
		if (!thinkingStripped) return;
		return { messages: stripEncryptedThinking(event.messages) };
	});

	pi.on(
		"agent_before_settle",
		async (_event, ctx): Promise<AgentBeforeSettleEventResult | void> => {
			if (!isGptModel(ctx.model)) return;

			const branch = ctx.sessionManager.getBranch();
			const { lastAssistant, lastUserEntryId } = scanLastMessageEntries(branch);
			if (lastAssistant?.message.stopReason !== "error") {
				retryCount = 0;
				return;
			}

			if (!is409SessionError(lastAssistant.message.errorMessage) || retryCount >= 1) {
				retryCount = 0;
				return;
			}

			retryCount++;

			// 1. Try pi-ext-memory compaction first
			const draft = getService(pi, MEMORY_COMPACTOR_SERVICE_KEY)?.createCompactionDraft(
				lastUserEntryId ?? null,
			);
			if (draft) {
				ctx.ui.notify(
					"检测到 GPT 409 会话失效错误，已通过 pi-ext-memory 压缩会话并自动重试…",
					"info",
				);
				const entries: SessionBoundaryDraft[] = [
					{ type: "compaction", summary: draft.summary, firstKeptEntryId: draft.firstKeptEntryId },
					{ type: "context_edit", targetId: lastAssistant.id, replacement: null },
				];
				return { entries, continue: true };
			}

			// 2. Fallback: strip thinking and continue using clean state going forward
			thinkingStripped = true;
			ctx.ui.notify("检测到 GPT 409 会话失效错误，已移除失效加密 thinking 并自动重试…", "info");
			return {
				entries: [{ type: "context_edit", targetId: lastAssistant.id, replacement: null }],
				continue: true,
			};
		},
	);

	return {
		isThinkingStripped: () => thinkingStripped,
		reset,
	};
}
