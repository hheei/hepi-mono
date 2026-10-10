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

const capturedByParentId = new Map<string, CapturedToolCall[]>();

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

export function recordToolExecutionStart(event: {
	toolCallId: string;
	toolName: string;
	args: unknown;
	parentToolCallId?: string | undefined;
}): void {
	if (!event.parentToolCallId) return;
	let list = capturedByParentId.get(event.parentToolCallId);
	if (!list) {
		if (capturedByParentId.size >= MAX_STORED_PARENTS) {
			const firstKey = capturedByParentId.keys().next().value;
			if (firstKey !== undefined) capturedByParentId.delete(firstKey);
		}
		list = [];
		capturedByParentId.set(event.parentToolCallId, list);
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

export function recordToolExecutionEnd(event: {
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
	durationMs?: number | undefined;
	parentToolCallId?: string | undefined;
}): void {
	if (!event.parentToolCallId) return;
	let list = capturedByParentId.get(event.parentToolCallId);
	if (!list) {
		if (capturedByParentId.size >= MAX_STORED_PARENTS) {
			const firstKey = capturedByParentId.keys().next().value;
			if (firstKey !== undefined) capturedByParentId.delete(firstKey);
		}
		list = [];
		capturedByParentId.set(event.parentToolCallId, list);
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

export function getCapturedNestedCalls(
	parentToolCallId: string | undefined,
): readonly CapturedToolCall[] | undefined {
	if (!parentToolCallId) return undefined;
	return capturedByParentId.get(parentToolCallId);
}

export function clearCapturedNestedCalls(): void {
	capturedByParentId.clear();
}
