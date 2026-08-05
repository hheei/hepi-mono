import type { MctxStatusAccounting } from "./status-metrics.js";

export type MctxMaintenanceDecision = "defer" | "execute";

export interface MctxMaintenanceScheduleInput {
	readonly accounting: MctxStatusAccounting;
	readonly usageTokens?: number;
	readonly contextWindow?: number | null;
	readonly percentageThreshold?: number;
	readonly absoluteThreshold?: number;
	readonly nowMs?: number;
}

/** Mirrors Magic Context's cache-aware maintenance gate without mutating runtime state. */
export function scheduleMctxMaintenance(
	input: MctxMaintenanceScheduleInput,
): MctxMaintenanceDecision {
	const usageTokens = input.usageTokens;
	const contextWindow = input.contextWindow;
	const percentageThreshold = input.percentageThreshold;
	const percentageExceeded =
		typeof usageTokens === "number" &&
		typeof contextWindow === "number" &&
		contextWindow > 0 &&
		typeof percentageThreshold === "number" &&
		usageTokens >= (contextWindow * percentageThreshold) / 100;
	const absoluteExceeded =
		typeof usageTokens === "number" &&
		typeof input.absoluteThreshold === "number" &&
		usageTokens >= input.absoluteThreshold;
	if (percentageExceeded || absoluteExceeded) return "execute";
	if (input.accounting.lastResponseAtMs === 0) return "defer";
	const nowMs = input.nowMs ?? Date.now();
	return nowMs - input.accounting.lastResponseAtMs > input.accounting.cacheTtlMs
		? "execute"
		: "defer";
}
