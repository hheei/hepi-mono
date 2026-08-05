import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const MCTX_TOOL_GUIDANCE =
	"MCTX history tools: use ctx_reduce only for old §N§ history no longer needed in this task. Keep recent/protected tags and any source you may need. Use ctx_expand to recover a dropped tag. Use ctx_history only for retained history from other sessions.";

/** Stable model-visible policy text. It is not persisted in the Pi transcript. */
export function injectMctxToolGuidance(messages: readonly AgentMessage[]): readonly AgentMessage[] {
	if (
		messages.some(
			(message) => message.role === "custom" && message.customType === "pi-mctx:tool-guidance",
		)
	)
		return messages;
	return [
		{
			role: "custom",
			customType: "pi-mctx:tool-guidance",
			content: MCTX_TOOL_GUIDANCE,
			display: false,
			timestamp: 0,
		},
		...messages,
	];
}
