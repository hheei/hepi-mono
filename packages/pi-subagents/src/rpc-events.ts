import { isRecord } from "@hheei/pi-ext-core";

/**
 * The Pi events a child forwards to its parent. Everything else — streaming token noise,
 * undocumented internals — is dropped, so the parent's projection only sees turn-level facts.
 */
export const FORWARDED_PI_EVENT_TYPES = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
	"auto_retry",
	"auto_retry_start",
	"auto_retry_end",
	"message_update",
	"agent_settled",
] as const;

export function shouldForwardPiEvent(event: unknown): boolean {
	if (!isRecord(event)) return false;
	return (
		typeof event.type === "string" &&
		(FORWARDED_PI_EVENT_TYPES as readonly string[]).includes(event.type)
	);
}
