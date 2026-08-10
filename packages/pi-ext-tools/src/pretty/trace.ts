import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export type ToolCompletion = {
	readonly durationMs?: number;
	readonly errorMessage?: string;
	readonly warning?: boolean;
};

type ToolRecord = {
	trace: number;
	startedAt?: number;
	completion?: ToolCompletion;
	latest?: AgentToolResult<unknown>;
	invalidate?: () => void;
};

/** Session-scoped renderer state. It is intentionally not persisted. */
export class ToolTraceController {
	private trace = 0;
	private readonly tools = new Map<string, ToolRecord>();

	startTrace(): void {
		this.trace += 1;
		for (const tool of this.tools.values()) {
			if (tool.trace < this.trace) tool.invalidate?.();
		}
	}

	begin(toolCallId: string): void {
		this.tools.set(toolCallId, { trace: this.trace, startedAt: performance.now() });
	}

	complete(toolCallId: string, warning = false): ToolCompletion {
		const tool = this.tools.get(toolCallId);
		const completion = {
			...(tool?.startedAt === undefined
				? {}
				: { durationMs: Math.round(performance.now() - tool.startedAt) }),
			...(warning ? { warning: true } : {}),
		};
		if (tool !== undefined) tool.completion = completion;
		return completion;
	}

	fail(toolCallId: string, error: unknown): ToolCompletion {
		const message = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : "failed";
		const completion = { ...this.complete(toolCallId), errorMessage: message || "failed" };
		const tool = this.tools.get(toolCallId);
		if (tool !== undefined) tool.completion = completion;
		return completion;
	}

	update(toolCallId: string, result: AgentToolResult<unknown>): void {
		const tool = this.tools.get(toolCallId);
		if (tool === undefined) return;
		tool.latest = result;
		tool.invalidate?.();
	}

	latestFor(toolCallId: string): AgentToolResult<unknown> | undefined {
		return this.tools.get(toolCallId)?.latest;
	}

	observe(toolCallId: string, executionStarted: boolean, invalidate: () => void): ToolRecord {
		const existing = this.tools.get(toolCallId);
		if (existing !== undefined) {
			existing.invalidate = invalidate;
			return existing;
		}
		const tool = { trace: executionStarted ? this.trace : -1, invalidate };
		this.tools.set(toolCallId, tool);
		return tool;
	}

	isCollapsed(
		toolCallId: string | undefined,
		expanded: boolean,
		executionStarted: boolean,
		invalidate: () => void,
	): boolean {
		if (toolCallId === undefined) return false;
		return !expanded && this.observe(toolCallId, executionStarted, invalidate).trace < this.trace;
	}

	completionFor(toolCallId: string): ToolCompletion | undefined {
		return this.tools.get(toolCallId)?.completion;
	}
}
