/** Compatibility-shaped policy helpers for the core-backed runner. */

import type { ConversationSubagentHandle } from "@hheei/pi-ext-core";

export const SUBAGENT_TOOL_NAMES = {
	AGENT: "Agent",
	GET_RESULT: "get_subagent_result",
	STEER: "steer_subagent",
} as const;

const DEFAULT_MAX_TURNS = 50;
const FIXED_GRACE_TURNS = 5;

let defaultMaxTurns = DEFAULT_MAX_TURNS;

export function getDefaultMaxTurns(): number {
	return defaultMaxTurns;
}

export function setDefaultMaxTurns(value: number): void {
	if (Number.isSafeInteger(value) && value > 0) defaultMaxTurns = value;
}

/** Core owns the fixed five-turn safety grace; callers cannot widen it. */
export function getGraceTurns(): number {
	return FIXED_GRACE_TURNS;
}

export function setGraceTurns(_value: number): void {
	// Kept as a settings migration sink. Core deliberately owns this limit.
}

export function normalizeMaxTurns(value: number | undefined): number {
	if (value === undefined) return defaultMaxTurns;
	return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export async function steerAgent(
	handle: ConversationSubagentHandle,
	message: string,
): Promise<void> {
	await handle.steer(message);
}
