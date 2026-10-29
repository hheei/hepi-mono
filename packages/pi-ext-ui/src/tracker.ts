import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The public read-only session view the lifecycle context hands an extension. */
type SessionReadSource = ExtensionContext["sessionManager"];

export interface CapturedToolCall {
	readonly id: string;
	readonly toolName: string;
	/** Positive resolution fact, when the host's `tool_call` hook reported this call. */
	readonly resolved?: boolean | undefined;
	readonly args?: unknown;
	/** The request existed but was too large to keep; the bytes are not recorded. */
	readonly argsTruncated?: boolean | undefined;
	readonly argsBytes?: number | undefined;
	readonly result?: AgentToolResult<unknown> | undefined;
	readonly isError?: boolean | undefined;
	readonly durationMs?: number | undefined;
	readonly cost?: number | undefined;
}

const MAX_STORED_PARENTS = 200;
/** A live capture keeps the request whole or not at all; a partial request would be a lie. */
const MAX_CAPTURED_PAYLOAD_CHARS = 32_768;
/** Host records at most this many nested calls per model-issued call. */
const MAX_RESOLVED_CALLS = 256;
/** Recovered arguments for at most this many calls; beyond it a row says it is not recorded. */
const MAX_INDEXED_CALLS = 512;

/**
 * The captured request, or the fact that it was too large to keep. Nothing is rewritten: a caller
 * either has the bytes the model sent or knows they are not recorded.
 */
function capturedArgs(
	args: unknown,
): Pick<CapturedToolCall, "args"> | Pick<CapturedToolCall, "argsTruncated" | "argsBytes"> {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(args);
	} catch {
		// A value the host could not serialize is kept as-is; its size is unknown, not zero.
		return { args };
	}
	if (serialized === undefined || serialized.length <= MAX_CAPTURED_PAYLOAD_CHARS) return { args };
	return { argsTruncated: true, argsBytes: serialized.length };
}

export class ToolExecutionTracker {
	readonly #capturedByParentId = new Map<string, CapturedToolCall[]>();
	readonly #resolvedByParentId = new Map<string, Set<string>>();

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
			...capturedArgs(event.args),
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

	/**
	 * The host's `tool_call` hook runs after the tool resolved and its arguments validated, so a
	 * recorded id is a positive fact. Nothing is recorded for a call the hook never saw: an unknown
	 * tool, an invalid argument set, a blocked or cancelled call all stay unknown.
	 */
	recordResolved(event: { toolCallId: string; parentToolCallId?: string | undefined }): void {
		const parent = event.parentToolCallId;
		if (!parent) return;
		let ids = this.#resolvedByParentId.get(parent);
		if (!ids) {
			if (this.#resolvedByParentId.size >= MAX_STORED_PARENTS) {
				const firstKey = this.#resolvedByParentId.keys().next().value;
				if (firstKey !== undefined) this.#resolvedByParentId.delete(firstKey);
			}
			ids = new Set();
			this.#resolvedByParentId.set(parent, ids);
		}
		if (ids.size >= MAX_RESOLVED_CALLS) return;
		ids.add(event.toolCallId);
	}

	getResolved(parentToolCallId: string | undefined): ReadonlySet<string> | undefined {
		if (!parentToolCallId) return undefined;
		return this.#resolvedByParentId.get(parentToolCallId);
	}

	clear(): void {
		this.#capturedByParentId.clear();
		this.#resolvedByParentId.clear();
	}
}

/** What the session branch says about one nested call's request. */
export interface NestedCallArgsFact {
	readonly args: unknown;
	/** The host kept the size but not the arguments, so the request is not recoverable. */
	readonly truncated: boolean;
	readonly bytes?: number | undefined;
}

/**
 * The arguments a resumed session saved for its nested calls. One index belongs to one runtime: it
 * follows that runtime's session, and shutting the runtime down or switching sessions drops it.
 */
export class NestedCallArgsIndex {
	#source: SessionReadSource | undefined;
	/** The leaf the index is complete up to; undefined means no index exists yet. */
	#indexedLeaf: string | null | undefined;
	readonly #argsById = new Map<string, NestedCallArgsFact>();

	/** The session owns the index: switching, reloading or shutting down replaces it. */
	setSource(manager: SessionReadSource | undefined): void {
		this.#source = manager;
		this.#reset();
	}

	args(toolCallId: string | undefined): NestedCallArgsFact | undefined {
		const manager = this.#source;
		if (manager === undefined || toolCallId === undefined) return undefined;
		try {
			this.#refresh(manager);
		} catch {
			this.#reset();
			return undefined;
		}
		return this.#argsById.get(toolCallId);
	}

	#reset(): void {
		this.#argsById.clear();
		this.#indexedLeaf = undefined;
	}

	#remember(id: string, fact: NestedCallArgsFact): void {
		if (!this.#argsById.has(id) && this.#argsById.size >= MAX_INDEXED_CALLS) {
			const firstKey = this.#argsById.keys().next().value;
			if (firstKey !== undefined) this.#argsById.delete(firstKey);
		}
		this.#argsById.set(id, fact);
	}

	/** The host saves a bounded record on the parent's tool result; this reads it back by call id. */
	#scan(entry: unknown): void {
		if (typeof entry !== "object" || entry === null) return;
		const record = entry as { type?: unknown; message?: unknown };
		if (record.type !== "message") return;
		const message = record.message;
		if (typeof message !== "object" || message === null) return;
		const toolResult = message as { role?: unknown; nestedCalls?: unknown };
		if (toolResult.role !== "toolResult") return;
		const nested = toolResult.nestedCalls;
		if (typeof nested !== "object" || nested === null) return;
		const calls = (nested as { calls?: unknown }).calls;
		if (!Array.isArray(calls)) return;
		for (const call of calls) {
			if (typeof call !== "object" || call === null) continue;
			const saved = call as { id?: unknown; arguments?: unknown; argumentsBytes?: unknown };
			if (typeof saved.id !== "string") continue;
			if (saved.arguments !== undefined) {
				this.#remember(saved.id, { args: saved.arguments, truncated: false });
			} else if (typeof saved.argumentsBytes === "number") {
				this.#remember(saved.id, {
					args: undefined,
					truncated: true,
					bytes: saved.argumentsBytes,
				});
			}
		}
	}

	/**
	 * Extend the index to the current leaf. An append walks only the new entries up to the previous
	 * leaf; a fork, branch switch or reload has no such chain and rebuilds. A render never scans the
	 * whole branch once the index is current, and a read failure is not cached as an empty answer.
	 */
	#refresh(manager: SessionReadSource): void {
		const leaf = manager.getLeafId();
		if (leaf === this.#indexedLeaf) return;
		if (leaf !== null && this.#indexedLeaf !== undefined) {
			const chain: string[] = [];
			let current: string | null = leaf;
			while (
				current !== null &&
				current !== this.#indexedLeaf &&
				chain.length <= MAX_INDEXED_CALLS
			) {
				chain.push(current);
				current = manager.getEntry(current)?.parentId ?? null;
			}
			if (current === this.#indexedLeaf) {
				for (const id of chain.reverse()) this.#scan(manager.getEntry(id));
				this.#indexedLeaf = leaf;
				return;
			}
		}
		this.#argsById.clear();
		for (const entry of manager.getBranch()) this.#scan(entry);
		this.#indexedLeaf = leaf;
	}
}
