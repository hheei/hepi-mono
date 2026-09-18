import type { SubagentState, UsageSummary } from "./domain.js";
export interface StateSnapshot {
	readonly state: SubagentState;
	readonly summary?: string;
	readonly interrupted?: string;
	readonly usage: UsageSummary;
}
export interface StateProjector {
	applyEvent(event: unknown): StateSnapshot;
	rebuild(entries: readonly unknown[]): StateSnapshot;
	snapshot(): StateSnapshot;
}
const EMPTY_USAGE: UsageSummary = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: 0,
	turns: 0,
};
function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}
function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function assistant(entry: unknown): { id: string; message: Record<string, unknown> } | undefined {
	const item = record(entry);
	const message = record(item?.message);
	return item?.type === "message" && typeof item.id === "string" && message?.role === "assistant"
		? { id: item.id, message }
		: undefined;
}
function text(message: Record<string, unknown>): string | undefined {
	if (!Array.isArray(message.content)) return undefined;
	const value = message.content
		.map((part) => {
			const item = record(part);
			return item?.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.join("")
		.trim();
	return value === "" ? undefined : value;
}
function completed(message: Record<string, unknown>): boolean {
	return message.stopReason !== "pending" && message.stopReason !== "deferred";
}
function diagnostic(message: Record<string, unknown>): string | undefined {
	if (message.stopReason === "aborted") return "Assistant turn was interrupted";
	if (message.stopReason !== "error") return undefined;
	return typeof message.errorMessage === "string" && message.errorMessage !== ""
		? message.errorMessage
		: "Assistant turn failed";
}
function messageUsage(message: Record<string, unknown>): Omit<UsageSummary, "turns"> | undefined {
	const usage = record(message.usage);
	const inputTokens = finite(usage?.input);
	const outputTokens = finite(usage?.output);
	const cacheReadTokens = finite(usage?.cacheRead);
	const cacheWriteTokens = finite(usage?.cacheWrite);
	if (
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheWriteTokens === undefined
	)
		return undefined;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		costUsd: finite(record(usage?.cost)?.total) ?? null,
	};
}
function add(total: UsageSummary, next: Omit<UsageSummary, "turns">): UsageSummary {
	return {
		inputTokens: total.inputTokens + next.inputTokens,
		outputTokens: total.outputTokens + next.outputTokens,
		cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
		cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
		costUsd: total.costUsd === null || next.costUsd === null ? null : total.costUsd + next.costUsd,
		turns: total.turns + 1,
	};
}
export function summarizeCurrentBranch(entries: readonly unknown[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry === undefined) continue;
		const item = assistant(entry);
		if (item === undefined || !completed(item.message)) continue;
		const value = text(item.message);
		if (value !== undefined) return value;
	}
	return undefined;
}
export function aggregateUsage(entries: readonly unknown[]): UsageSummary {
	let total = EMPTY_USAGE;
	const seen = new Set<string>();
	for (const entry of entries) {
		const item = assistant(entry);
		if (item === undefined || seen.has(item.id) || !completed(item.message)) continue;
		seen.add(item.id);
		const usage = messageUsage(item.message);
		if (usage !== undefined) total = add(total, usage);
	}
	return total;
}
export function createStateProjector(initialState: SubagentState = "starting"): StateProjector {
	let state = initialState;
	let summary: string | undefined;
	let interrupted: string | undefined;
	let usage: UsageSummary = EMPTY_USAGE;
	const snapshot = (): StateSnapshot => ({
		state,
		...(summary === undefined ? {} : { summary }),
		...(interrupted === undefined ? {} : { interrupted }),
		usage,
	});
	return {
		applyEvent(event) {
			const value = record(event);
			if (value === undefined) return snapshot();
			if (value.type === "agent_start") state = "running";
			else if (value.type === "agent_end" || value.type === "agent_settled") {
				state = "idle";
				const messages = Array.isArray(value.messages) ? value.messages : [];
				const message = record(messages.length > 0 ? messages[messages.length - 1] : value.message);
				if (message?.role === "assistant") {
					summary = text(message) ?? summary;
					interrupted = diagnostic(message) ?? interrupted;
					if (message.stopReason === "error") state = "failed";
				}
			} else if (value.type === "error") {
				state = "failed";
				interrupted =
					typeof value.message === "string" ? value.message : "Runner reported an error";
			} else if (value.type === "runner_exit" || value.type === "exit") {
				state = value.code === 0 ? "done" : "failed";
				if (value.code !== 0)
					interrupted = `Runner exited${typeof value.code === "number" ? ` with code ${value.code}` : " unexpectedly"}`;
			}
			return snapshot();
		},
		rebuild(entries) {
			summary = summarizeCurrentBranch(entries);
			usage = aggregateUsage(entries);
			for (const entry of entries) {
				const item = assistant(entry);
				if (item === undefined || !completed(item.message)) continue;
				interrupted = diagnostic(item.message) ?? interrupted;
				if (item.message.stopReason === "error") state = "failed";
			}
			return snapshot();
		},
		snapshot,
	};
}
