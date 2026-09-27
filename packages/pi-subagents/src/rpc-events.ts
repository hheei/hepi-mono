import { isRecord } from "@hheei/pi-ext-core";

/**
 * Runner-local and child-lifecycle events are produced by the runner itself.
 * Only these Pi RPC event types are forwarded to a controller; everything
 * else (streaming token noise, undocumented internals) is dropped.
 */
export const FORWARDED_PI_EVENT_TYPES = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"auto_retry",
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

export function isIdlePiState(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		value.isStreaming === false && value.isCompacting === false && value.pendingMessageCount === 0
	);
}
