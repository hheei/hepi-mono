import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export interface CapturedToolCall {
	readonly id: string;
	readonly toolName: string;
	readonly args?: unknown;
	readonly result?: AgentToolResult<unknown> | undefined;
	readonly isError?: boolean | undefined;
	readonly durationMs?: number | undefined;
	readonly cost?: number | undefined;
}

const MAX_STORED_PARENTS = 200;
const MAX_CAPTURED_PAYLOAD_CHARS = 32_768;

function boundCapturedValue<T>(val: T): T {
	if (typeof val === "string") {
		return val.length > MAX_CAPTURED_PAYLOAD_CHARS
			? (`${val.slice(0, MAX_CAPTURED_PAYLOAD_CHARS)}… (truncated)` as unknown as T)
			: val;
	}
	return val;
}

export class ToolExecutionTracker {
	readonly #capturedByParentId = new Map<string, CapturedToolCall[]>();

	recordStart(event: {
		toolCallId: string;
		toolName: string;
		args: unknown;
		parentToolCallId?: string | undefined;
	}): void {
		if (!event.parentToolCallId) return;
		let list = this.#capturedByParentId.get(event.parentToolCallId);
		if (!list) {
			if (this.#capturedByParentId.size >= MAX_STORED_PARENTS) {
				const firstKey = this.#capturedByParentId.keys().next().value;
				if (firstKey !== undefined) this.#capturedByParentId.delete(firstKey);
			}
			list = [];
			this.#capturedByParentId.set(event.parentToolCallId, list);
		}
		const idx = list.findIndex((c) => c.id === event.toolCallId);
		const entry: CapturedToolCall = {
			id: event.toolCallId,
			toolName: event.toolName,
			args: boundCapturedValue(event.args),
		};
		if (idx >= 0) {
			list[idx] = { ...list[idx], ...entry };
		} else {
			list.push(entry);
		}
	}

	recordEnd(event: {
		toolCallId: string;
		toolName: string;
		result: unknown;
		isError: boolean;
		durationMs?: number | undefined;
		parentToolCallId?: string | undefined;
	}): void {
		if (!event.parentToolCallId) return;
		let list = this.#capturedByParentId.get(event.parentToolCallId);
		if (!list) {
			if (this.#capturedByParentId.size >= MAX_STORED_PARENTS) {
				const firstKey = this.#capturedByParentId.keys().next().value;
				if (firstKey !== undefined) this.#capturedByParentId.delete(firstKey);
			}
			list = [];
			this.#capturedByParentId.set(event.parentToolCallId, list);
		}
		const idx = list.findIndex((c) => c.id === event.toolCallId);
		const typedResult = event.result as AgentToolResult<unknown> | undefined;
		if (idx >= 0) {
			const prev = list[idx];
			if (!prev) return;
			list[idx] = {
				...prev,
				result: typedResult,
				isError: event.isError,
				durationMs: event.durationMs,
			};
		} else {
			list.push({
				id: event.toolCallId,
				toolName: event.toolName,
				result: typedResult,
				isError: event.isError,
				durationMs: event.durationMs,
			});
		}
	}

	getCaptured(parentToolCallId: string | undefined): readonly CapturedToolCall[] | undefined {
		if (!parentToolCallId) return undefined;
		return this.#capturedByParentId.get(parentToolCallId);
	}

	clear(): void {
		this.#capturedByParentId.clear();
	}
}

const defaultTracker = new ToolExecutionTracker();

export function recordToolExecutionStart(event: {
	toolCallId: string;
	toolName: string;
	args: unknown;
	parentToolCallId?: string | undefined;
}): void {
	defaultTracker.recordStart(event);
}

export function recordToolExecutionEnd(event: {
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
	durationMs?: number | undefined;
	parentToolCallId?: string | undefined;
}): void {
	defaultTracker.recordEnd(event);
}

export function getCapturedNestedCalls(
	parentToolCallId: string | undefined,
): readonly CapturedToolCall[] | undefined {
	return defaultTracker.getCaptured(parentToolCallId);
}

export function clearCapturedNestedCalls(): void {
	defaultTracker.clear();
}
