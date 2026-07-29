import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordExternalPiSubagentInvocation } from "./external-subagent-accounting";

const MAGIC_CONTEXT_PI_SUBAGENT_ENV = "MAGIC_CONTEXT_PI_SUBAGENT";
const CHANNEL1_REMINDER_MARKERS = [
	"tokens of tool output you have not reduced",
	"tokens of unreduced tool output",
] as const;

type InvocationStatus = "completed" | "failed" | "aborted";
type RecordInvocation = (input: unknown) => number | null;

interface ReminderState {
	current: symbol | undefined;
	readonly pendingBySessionId: Map<string, string[]>;
}

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

interface ExtensionEventBus {
	on(event: string, listener: (event: unknown) => void): unknown;
}

declare global {
	var __magicContextPiReminderStates: WeakMap<object, ReminderState> | undefined;
	var __magicContextPiAccountingStates: WeakMap<object, AccountingState> | undefined;
}

function getReminderState(events: object): ReminderState {
	let states = globalThis.__magicContextPiReminderStates;
	if (states === undefined) {
		states = new WeakMap();
		globalThis.__magicContextPiReminderStates = states;
	}
	const existing = states.get(events);
	if (existing !== undefined) return existing;
	const created: ReminderState = {
		current: undefined,
		pendingBySessionId: new Map(),
	};
	states.set(events, created);
	return created;
}

function getAccountingState(events: object): AccountingState {
	let states = globalThis.__magicContextPiAccountingStates;
	if (states === undefined) {
		states = new WeakMap();
		globalThis.__magicContextPiAccountingStates = states;
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

function textFromContentPart(part: unknown): string | undefined {
	if (typeof part === "string") return part;
	if (
		part !== null &&
		typeof part === "object" &&
		"type" in part &&
		part.type === "text" &&
		"text" in part &&
		typeof part.text === "string"
	) {
		return part.text;
	}
	return undefined;
}

function isChannel1Reminder(part: unknown): boolean {
	const text = textFromContentPart(part);
	return (
		text?.includes("<system-reminder>") === true &&
		text.includes("ctx_reduce") &&
		CHANNEL1_REMINDER_MARKERS.some((marker) => text.includes(marker))
	);
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

function registerReminderBridge(pi: ExtensionAPI): void {
	const events = (pi as unknown as { events?: unknown }).events;
	const state = getReminderState(
		events !== null && typeof events === "object" ? events : pi,
	);
	const token = Symbol("magic-context-pi-reminder-bridge");
	state.current = token;
	const isCurrent = (): boolean => state.current === token;

	pi.on("tool_result", async (event, ctx) => {
		if (!isCurrent()) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const reminders = event.content
			.filter(isChannel1Reminder)
			.map((part) => textFromContentPart(part))
			.filter((text): text is string => text !== undefined);
		if (reminders.length === 0) return;
		const pending = state.pendingBySessionId.get(sessionId) ?? [];
		pending.push(...reminders);
		state.pendingBySessionId.set(sessionId, pending);
		return { content: event.content.filter((part) => !isChannel1Reminder(part)) };
	});

	pi.on("context", async (event, ctx) => {
		if (!isCurrent()) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const reminders = state.pendingBySessionId.get(sessionId);
		if (reminders === undefined || reminders.length === 0) return;
		state.pendingBySessionId.delete(sessionId);
		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					customType: "magic-context-context-reminder",
					content: reminders.join("\n\n"),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (isCurrent()) state.pendingBySessionId.delete(ctx.sessionManager.getSessionId());
	});
}

function registerSubagentAccounting(
	pi: ExtensionAPI,
	recordInvocation: RecordInvocation = recordExternalPiSubagentInvocation,
): void {
	if (process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] === "1") return;

	const events = pi.events as unknown as ExtensionEventBus;
	const state = getAccountingState(events as object);
	const token = Symbol("magic-context-pi-subagent-accounting");
	state.current = token;
	const isCurrent = (): boolean => state.current === token;

	pi.on("session_start", async (_event, ctx) => {
		if (!isCurrent()) return;
		state.sessionId = ctx.sessionManager.getSessionId();
		state.startedAtByAgentId.clear();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!isCurrent()) return;
		if (state.sessionId === ctx.sessionManager.getSessionId()) {
			state.sessionId = undefined;
			state.startedAtByAgentId.clear();
		}
	});

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

export function registerPiRuntimeBridges(
	pi: ExtensionAPI,
	recordInvocation?: RecordInvocation,
): void {
	registerReminderBridge(pi);
	const events = (pi as unknown as { events?: unknown }).events;
	if (events === null || typeof events !== "object") return;
	registerSubagentAccounting(pi, recordInvocation);
}
