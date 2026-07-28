import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordExternalPiSubagentInvocation } from "@hheei/pi-magic-context";
import {
	HepiLifecycleController,
	registerHepiLifecycle,
} from "../../hepi-basics/src/core/index.js";

const MAGIC_CONTEXT_PI_SUBAGENT_ENV = "MAGIC_CONTEXT_PI_SUBAGENT";

type InvocationStatus = "completed" | "failed" | "aborted";
type RecordInvocation = (input: unknown) => number | null;

interface AccountingState {
	current: symbol | undefined;
	sessionId: string | undefined;
	readonly startedAtByAgentId: Map<string, number>;
}

interface SubagentStartedEvent {
	readonly id: string;
}

interface SubagentTerminalEvent {
	readonly id: string;
	readonly type: string;
	readonly status: InvocationStatus;
	readonly durationMs: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

declare global {
	var __hepiMagicContextSubagentAccountingStates: WeakMap<object, AccountingState> | undefined;
}

function getState(events: object): AccountingState {
	let states = globalThis.__hepiMagicContextSubagentAccountingStates;
	if (states === undefined) {
		states = new WeakMap();
		globalThis.__hepiMagicContextSubagentAccountingStates = states;
	}
	const existing = states.get(events);
	if (existing !== undefined) return existing;
	const created: AccountingState = {
		current: undefined,
		sessionId: undefined,
		startedAtByAgentId: new Map(),
	};
	states.set(events, created);
	return created;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseStartedEvent(value: unknown): SubagentStartedEvent | undefined {
	if (!isObject(value) || !isNonEmptyString(value.id)) return undefined;
	return { id: value.id };
}

function parseTerminalEvent(value: unknown, failed: boolean): SubagentTerminalEvent | undefined {
	if (!isObject(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.type)) {
		return undefined;
	}
	const status: InvocationStatus =
		value.status === "aborted" || value.status === "stopped"
			? "aborted"
			: failed || value.status === "error"
				? "failed"
				: "completed";
	const tokens = isObject(value.tokens) ? value.tokens : undefined;
	return {
		id: value.id,
		type: value.type,
		status,
		durationMs: finiteNonNegative(value.durationMs),
		inputTokens: finiteNonNegative(tokens?.input),
		outputTokens: finiteNonNegative(tokens?.output),
	};
}

interface ExtensionEventBus {
	on(event: string, listener: (event: unknown) => void): unknown;
}

/** Record pi-subagents metadata in the parent Magic Context session. */
export function registerMagicContextSubagentAccounting(
	pi: ExtensionAPI,
	recordInvocation: RecordInvocation = recordExternalPiSubagentInvocation,
): void {
	if (process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] === "1") return;

	const events = pi.events as unknown as ExtensionEventBus;
	const state = getState(events as object);
	const token = Symbol("magic-context-subagent-accounting");
	state.current = token;
	const isCurrent = (): boolean => state.current === token;
	const lifecycle = new HepiLifecycleController({
		onStart: (runtime) => {
			if (!isCurrent()) return;
			state.sessionId = runtime.ctx.sessionManager.getSessionId();
			state.startedAtByAgentId.clear();
		},
		onShutdown: () => {
			if (!isCurrent()) return;
			state.sessionId = undefined;
			state.startedAtByAgentId.clear();
		},
	});
	registerHepiLifecycle(pi, lifecycle, "pi-mctx-subagent-accounting");

	events.on("subagents:started", (event) => {
		if (!isCurrent() || state.sessionId === undefined) return;
		const started = parseStartedEvent(event);
		if (started !== undefined) state.startedAtByAgentId.set(started.id, Date.now());
	});

	const recordTerminal = (event: unknown, failed: boolean): void => {
		if (!isCurrent() || state.sessionId === undefined) return;
		const terminal = parseTerminalEvent(event, failed);
		if (terminal === undefined) return;
		const endedAt = Date.now();
		const startedAt = state.startedAtByAgentId.get(terminal.id) ?? endedAt - terminal.durationMs;
		state.startedAtByAgentId.delete(terminal.id);
		try {
			recordInvocation({
				parentSessionId: state.sessionId,
				type: terminal.type,
				startedAt,
				endedAt,
				status: terminal.status,
				inputTokens: terminal.inputTokens,
				outputTokens: terminal.outputTokens,
			});
		} catch {
			// Accounting must not affect the parent agent or child completion flow.
		}
	};

	events.on("subagents:completed", (event) => recordTerminal(event, false));
	events.on("subagents:failed", (event) => recordTerminal(event, true));
}
