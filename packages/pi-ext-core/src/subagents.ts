import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getGlobalState } from "./global-state.js";
import type { ExtensionLifecycleContext } from "./lifecycle.js";
import { runtimeIdentity } from "./runtime-identity.js";

declare const subagentIdBrand: unique symbol;
declare const conversationMessageSequenceBrand: unique symbol;

/** Opaque core-generated identifier for one parent-session-scoped operation. */
export type SubagentId = string & { readonly [subagentIdBrand]: true };

/** Monotonic identifier for one message accepted by a Conversation handle. */
export type ConversationMessageSequence = number & {
	readonly [conversationMessageSequenceBrand]: true;
};

/** Execution contracts: one-shot text, terminal child task, or reusable conversation. */
export type SubagentMode = "completion" | "task" | "conversation";

/** Lifecycle state visible on a handle; terminal states never become active again. */
export type SubagentStatus =
	| "queued"
	| "running"
	| "idle"
	| "completed"
	| "failed"
	| "cancelled"
	| "limit_reached";

/**
 * One root-session resource budget shared by every direct core subagent consumer.
 * Core exports this value rather than creating a runtime implicitly: the first
 * consumer still installs it during lifecycle start, while every later consumer
 * verifies the same CPU, queue-memory, and result-retention limit.
 */
export const DEFAULT_SUBAGENT_COORDINATOR_BUDGET = {
	maxActiveTurns: 2,
	maxPending: 16,
	maxRetainedTerminal: 32,
} as const;

export interface ConfigureSubagentCoordinatorOptions {
	/** Positive integer cap shared by all active child turns in this Pi runtime. */
	readonly maxActiveTurns: number;
	/** Maximum FIFO operations waiting for an active-turn slot. */
	readonly maxPending: number;
	/** Maximum terminal handles retained for lookup/redelivery in this parent lifecycle. */
	readonly maxRetainedTerminal: number;
}

export interface CompletionSubagentSpec {
	/** One model completion owned by core after admission. */
	readonly mode: "completion";
	/** Resolved model. Core reads its credential through the lifecycle model registry. */
	readonly model: Model<Api>;
	readonly prompt: string;
	/** Pre-resolved messages for a one-shot completion; when absent core uses `prompt` as one user message. */
	readonly messages?: Context["messages"];
	readonly systemPrompt: string;
	readonly thinkingLevel: ThinkingLevel;
}

/**
 * Consumer-owned, immutable child-session policy resolved before execution.
 * Core invokes this once after admission, then exclusively owns prompt, abort,
 * terminalization, and disposal of the returned session.
 */
export interface ResolvedChildSessionFactory {
	create(signal: AbortSignal): Promise<AgentSession>;
}

export interface TaskTerminalResult {
	readonly id: SubagentId;
	readonly mode: "task";
	readonly status: "completed" | "failed" | "cancelled" | "limit_reached";
	readonly output: string;
	readonly softLimitReached: boolean;
	readonly failure?: string;
}

/**
 * Caller-owned terminal delivery. It must not mutate parent state after `signal`
 * aborts; a rejected delivery does not change the Task terminal result.
 */
export type TaskTerminalDeliverySink = (
	result: TaskTerminalResult,
	signal: AbortSignal,
) => void | Promise<void>;

export interface TaskSubagentSpec {
	/** Child-session task whose terminal output is delivered to the caller's sink. */
	readonly mode: "task";
	readonly session: ResolvedChildSessionFactory;
	readonly prompt: string;
	/** Positive soft turn cap. Core gives one wrap-up steer and five fixed grace turns. */
	readonly maxTurns: number;
	readonly delivery: TaskTerminalDeliverySink;
}

export type ConversationInputMode = "queue" | "steer";

export interface ConversationReplyResult {
	readonly id: SubagentId;
	readonly sequence: ConversationMessageSequence;
	readonly status: "completed" | "failed" | "cancelled" | "limit_reached" | "steered";
	readonly output: string;
	readonly softLimitReached: boolean;
	readonly failure?: string;
}

/** Provider-normalized usage accumulated from completed child assistant turns. */
export interface ConversationUsage {
	readonly input: number;
	readonly output: number;
	readonly total: number;
	readonly cost: number;
}

/** Caller-owned parent delivery for one Conversation reply. */
export type ConversationReplyDeliverySink = (
	result: ConversationReplyResult,
	signal: AbortSignal,
) => void | Promise<void>;

export type ConversationReplyConsumption =
	| { readonly kind: "wait"; readonly signal: AbortSignal }
	| { readonly kind: "delivery"; readonly delivery: ConversationReplyDeliverySink };

export interface ConversationSendOptions {
	readonly inputMode?: ConversationInputMode;
	readonly reply: ConversationReplyConsumption;
}

export interface ConversationSubagentSpec {
	/** Root-only child conversation; the raw child session remains opaque to consumers. */
	readonly mode: "conversation";
	readonly session: ResolvedChildSessionFactory;
	/** First child message. Creation never starts an unowned prompt. */
	readonly initialMessage: string;
	readonly initialReply: ConversationReplyConsumption;
	/** Queue delivery used when a parent abort cancels an initial/send wait observer. */
	readonly fallbackDelivery: ConversationReplyDeliverySink;
	/** Positive soft turn cap for every message reply. */
	readonly maxTurnsPerReply: number;
}

export type SubagentSpec = CompletionSubagentSpec | TaskSubagentSpec | ConversationSubagentSpec;

export interface CompletionSubagentResult {
	readonly id: SubagentId;
	readonly mode: "completion";
	readonly status: "completed" | "failed" | "cancelled";
	readonly output: string;
	readonly failure?: string;
}

export interface ConversationDeliveryAcknowledgement {
	readonly id: SubagentId;
	readonly sequence: ConversationMessageSequence;
	/** Delivery was accepted; its sink runs only after the child reply settles. */
	readonly accepted: true;
}

export interface SubagentEventSubscription {
	dispose(): void;
}

export type SubagentEventKind = "text" | "tool" | "turn" | "terminal";

/** Latest text snapshot. Intermediate text updates may have coalesced. */
export interface SubagentTextEvent {
	readonly kind: "text";
	readonly id: SubagentId;
	readonly text: string;
}

/** Latest tool activity snapshot. Intermediate tool transitions may have coalesced. */
export interface SubagentToolEvent {
	readonly kind: "tool";
	readonly id: SubagentId;
	readonly toolName: string;
	readonly state: "start" | "end";
}

/** Latest child turn state snapshot. */
export interface SubagentTurnEvent {
	readonly kind: "turn";
	readonly id: SubagentId;
	readonly state: "queued" | "running" | "idle";
}

export interface ConversationTerminalResult {
	readonly id: SubagentId;
	readonly mode: "conversation";
	readonly status: "failed" | "cancelled";
	readonly failure?: string;
}

export type SubagentTerminalResult =
	| CompletionSubagentResult
	| TaskTerminalResult
	| ConversationTerminalResult;

/** Terminal events are never dropped when a subscription queue reaches its cap. */
export interface SubagentTerminalEvent {
	readonly kind: "terminal";
	readonly id: SubagentId;
	readonly result: SubagentTerminalResult;
}

export type SubagentEvent =
	| SubagentTextEvent
	| SubagentToolEvent
	| SubagentTurnEvent
	| SubagentTerminalEvent;

export interface SubscribeSubagentEventsOptions {
	readonly kinds: ReadonlySet<SubagentEventKind>;
	readonly signal: AbortSignal;
	/** Callbacks receive bounded snapshots and must not block child execution. */
	readonly onEvent: (event: SubagentEvent) => void | Promise<void>;
}

export interface BaseSubagentHandle<TMode extends SubagentMode, TResult> {
	readonly id: SubagentId;
	readonly mode: TMode;
	readonly status: SubagentStatus;
	readonly result: Promise<TResult>;
	cancel(): void;
	subscribe(options: SubscribeSubagentEventsOptions): SubagentEventSubscription;
}

export interface CompletionSubagentHandle
	extends BaseSubagentHandle<"completion", CompletionSubagentResult> {}

export interface TaskSubagentHandle extends BaseSubagentHandle<"task", TaskTerminalResult> {}

export interface ConversationSubagentHandle
	extends BaseSubagentHandle<"conversation", ConversationTerminalResult> {
	/** Outcome of the required initial message; await only when initialReply.kind is `wait`. */
	readonly initialReply: Promise<ConversationReplyResult>;
	/**
	 * Requests core-owned compaction while the child is idle. The raw child session
	 * remains opaque; running, queued, and terminal conversations reject this call.
	 */
	compact(): Promise<void>;
	/** Read-only cumulative usage from completed child assistant turns. */
	usage(): ConversationUsage;
	send(
		message: string,
		options: ConversationSendOptions & { readonly reply: { readonly kind: "wait" } },
	): Promise<ConversationReplyResult>;
	send(
		message: string,
		options: ConversationSendOptions & {
			readonly reply: {
				readonly kind: "delivery";
				readonly delivery: ConversationReplyDeliverySink;
			};
		},
	): Promise<ConversationDeliveryAcknowledgement>;
	send(
		message: string,
		options: ConversationSendOptions,
	): Promise<ConversationReplyResult | ConversationDeliveryAcknowledgement>;
}

/** Mode-specific control and result surface retained for this parent lifecycle. */
export type SubagentHandle =
	| CompletionSubagentHandle
	| TaskSubagentHandle
	| ConversationSubagentHandle;

/**
 * Installs the sole live root coordinator configuration for this lifecycle.
 * A second live owner is a collision error; lifecycle abort releases ownership.
 */
export function configureSubagentCoordinator(
	context: ExtensionLifecycleContext,
	options: ConfigureSubagentCoordinatorOptions,
): void {
	for (const [name, value] of Object.entries(options)) {
		if (!Number.isSafeInteger(value) || value < 1)
			throw new Error(`${name} must be a positive integer`);
	}
	const coordinator = getCoordinator(context);
	if (coordinator.budget !== undefined) {
		if (
			coordinator.budget.maxActiveTurns === options.maxActiveTurns &&
			coordinator.budget.maxPending === options.maxPending &&
			coordinator.budget.maxRetainedTerminal === options.maxRetainedTerminal
		)
			return;
		throw new Error("Subagent coordinator budget collision");
	}
	coordinator.budget = options;
	const release = (): void => {
		if (coordinator.ownerSignal === context.signal) {
			coordinator.budget = undefined;
			coordinator.ownerSignal = undefined;
		}
	};
	coordinator.ownerSignal = context.signal;
	context.signal.addEventListener("abort", release, { once: true });
}

/**
 * Starts one root-session-scoped completion, task, or conversation. The shared
 * coordinator must already be configured by its lifecycle owner; admission is
 * bounded by the common active-turn cap and the caller owns result delivery.
 */
export function startSubagent(
	_context: ExtensionLifecycleContext,
	_spec: CompletionSubagentSpec,
): CompletionSubagentHandle;
export function startSubagent(
	_context: ExtensionLifecycleContext,
	_spec: TaskSubagentSpec,
): TaskSubagentHandle;
export function startSubagent(
	_context: ExtensionLifecycleContext,
	_spec: ConversationSubagentSpec,
): ConversationSubagentHandle;
export function startSubagent(
	_context: ExtensionLifecycleContext,
	_spec: SubagentSpec,
): SubagentHandle;
export function startSubagent(
	context: ExtensionLifecycleContext,
	spec: SubagentSpec,
): SubagentHandle {
	const coordinator = getCoordinator(context);
	if (coordinator.budget === undefined) {
		throw new Error("Subagent coordinator is not configured for this Pi runtime");
	}
	switch (spec.mode) {
		case "completion":
			return startCompletion(context, coordinator, spec);
		case "task":
			return startTask(context, coordinator, spec);
		case "conversation":
			return startConversation(context, coordinator, spec);
	}
}

/** Returns a retained handle for this parent lifecycle, if its bounded record still exists. */
export function lookupSubagent(
	context: ExtensionLifecycleContext,
	id: SubagentId,
): SubagentHandle | undefined {
	return getCoordinator(context).handles.get(id)?.handle;
}

/** Explicitly retries delivery of one retained Task result without rerunning execution. */
export function redeliverTask(
	context: ExtensionLifecycleContext,
	id: SubagentId,
	delivery: TaskTerminalDeliverySink,
): Promise<void> {
	const record = getCoordinator(context).handles.get(id);
	if (record?.terminal === undefined || record.handle.mode !== "task") {
		return Promise.reject(new Error(`No retained Task result exists for ${id}`));
	}
	const delivered = delivery(record.terminal as TaskTerminalResult, record.controller.signal);
	if (delivered === undefined) return Promise.resolve();
	// Redelivery failure belongs to the caller's sink; the retained terminal
	// execution result remains available for another explicit attempt.
	return delivered.then(
		() => undefined,
		() => undefined,
	);
}

interface Coordinator {
	budget: ConfigureSubagentCoordinatorOptions | undefined;
	ownerSignal: AbortSignal | undefined;
	activeTurns: number;
	nextId: number;
	readonly queue: QueuedOperation[];
	readonly handles: Map<SubagentId, HandleRecord>;
	readonly terminalIds: SubagentId[];
}

interface HandleRecord {
	readonly controller: AbortController;
	readonly handle: SubagentHandle;
	readonly subscribers: Set<EventSubscriber>;
	started: boolean;
	cancelQueued: (() => void) | undefined;
	terminal: SubagentTerminalResult | undefined;
}

interface QueuedOperation {
	readonly record: HandleRecord;
	readonly start: () => void;
}

interface EventSubscriber {
	readonly options: SubscribeSubagentEventsOptions;
	readonly queue: SubagentEvent[];
	running: boolean;
	disposed: boolean;
}

function getCoordinator(context: ExtensionLifecycleContext): Coordinator {
	const coordinators = getGlobalState(
		"subagent-coordinators",
		(): WeakMap<object, Coordinator> => new WeakMap(),
	);
	const identity = runtimeIdentity(context.pi);
	const existing = coordinators.get(identity);
	if (existing !== undefined) return existing;
	const created: Coordinator = {
		budget: undefined,
		ownerSignal: undefined,
		activeTurns: 0,
		nextId: 0,
		queue: [],
		handles: new Map(),
		terminalIds: [],
	};
	coordinators.set(identity, created);
	return created;
}

function nextId(coordinator: Coordinator): SubagentId {
	coordinator.nextId += 1;
	return `subagent-${coordinator.nextId}` as SubagentId;
}

function removeQueuedOperation(coordinator: Coordinator, record: HandleRecord): void {
	const index = coordinator.queue.findIndex((queued) => queued.record === record);
	if (index >= 0) coordinator.queue.splice(index, 1);
}

function disposeSubscribers(record: HandleRecord): void {
	for (const subscriber of record.subscribers) {
		subscriber.disposed = true;
		subscriber.queue.length = 0;
	}
	record.subscribers.clear();
}

function releaseRecord(coordinator: Coordinator, record: HandleRecord, abort: boolean): void {
	removeQueuedOperation(coordinator, record);
	if (abort) record.controller.abort();
	disposeSubscribers(record);
	if (coordinator.handles.get(record.handle.id) === record) {
		coordinator.handles.delete(record.handle.id);
		const terminalIndex = coordinator.terminalIds.indexOf(record.handle.id);
		if (terminalIndex >= 0) coordinator.terminalIds.splice(terminalIndex, 1);
	}
}

function cancelRecord(coordinator: Coordinator, record: HandleRecord): void {
	record.controller.abort();
	if (record.started || record.terminal !== undefined) return;
	removeQueuedOperation(coordinator, record);
	record.cancelQueued?.();
}

function retainTerminal(coordinator: Coordinator, record: HandleRecord): void {
	if (coordinator.handles.get(record.handle.id) !== record) return;
	coordinator.terminalIds.push(record.handle.id);
	const budget = coordinator.budget;
	if (budget === undefined) return;
	while (coordinator.terminalIds.length > budget.maxRetainedTerminal) {
		const oldestId = coordinator.terminalIds.shift();
		if (oldestId === undefined) return;
		const oldest = coordinator.handles.get(oldestId);
		if (oldest !== undefined) releaseRecord(coordinator, oldest, false);
	}
}

function registerRecord(
	context: ExtensionLifecycleContext,
	coordinator: Coordinator,
	record: HandleRecord,
): void {
	coordinator.handles.set(record.handle.id, record);
	context.signal.addEventListener(
		"abort",
		() => {
			if (!record.started && record.terminal === undefined) record.cancelQueued?.();
			releaseRecord(coordinator, record, true);
		},
		{ once: true },
	);
}

function admit(
	coordinator: Coordinator,
	record: HandleRecord,
	operation: () => Promise<void>,
): boolean {
	const start = (): void => {
		if (record.terminal !== undefined) return;
		record.started = true;
		coordinator.activeTurns += 1;
		void operation().finally(() => {
			coordinator.activeTurns -= 1;
			const queued = coordinator.queue.shift();
			queued?.start();
		});
	};
	const budget = coordinator.budget;
	if (budget === undefined) return false;
	if (coordinator.activeTurns < budget.maxActiveTurns) {
		start();
		return true;
	}
	if (coordinator.queue.length >= budget.maxPending) return false;
	coordinator.queue.push({ record, start });
	return true;
}

function createController(signal: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", () => controller.abort(), { once: true });
	return controller;
}

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assistantText(message: AssistantMessage | undefined): string {
	if (message === undefined) return "";
	return message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("")
		.trim();
}

function lastAssistantText(session: AgentSession, startIndex: number): string {
	for (let index = session.messages.length - 1; index >= startIndex; index -= 1) {
		const message = session.messages[index];
		if (message?.role === "assistant") return assistantText(message);
	}
	return "";
}

const EMPTY_CONVERSATION_USAGE: ConversationUsage = { input: 0, output: 0, total: 0, cost: 0 };

function finiteUsage(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFromMessages(
	messages: readonly AgentSession["messages"][number][],
): ConversationUsage {
	let usage = EMPTY_CONVERSATION_USAGE;
	for (const message of messages) {
		if (message.role !== "assistant" || message.usage === undefined) continue;
		const cost = message.usage.cost;
		usage = {
			input: usage.input + finiteUsage(message.usage.input),
			output: usage.output + finiteUsage(message.usage.output),
			total: usage.total + finiteUsage(message.usage.totalTokens),
			cost:
				usage.cost +
				finiteUsage(
					typeof cost === "object" && cost !== null && "total" in cost ? cost.total : undefined,
				),
		};
	}
	return usage;
}

function addConversationUsage(
	left: ConversationUsage,
	right: ConversationUsage,
): ConversationUsage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		total: left.total + right.total,
		cost: left.cost + right.cost,
	};
}

function emit(record: HandleRecord, event: SubagentEvent): void {
	for (const subscriber of record.subscribers) {
		if (subscriber.disposed || !subscriber.options.kinds.has(event.kind)) continue;
		if (event.kind === "terminal") subscriber.queue.push(event);
		else if (subscriber.queue.length < 16) subscriber.queue.push(event);
		else {
			const prior = subscriber.queue.findIndex((candidate) => candidate.kind === event.kind);
			if (prior >= 0) subscriber.queue[prior] = event;
		}
		pumpSubscriber(subscriber);
	}
}

function pumpSubscriber(subscriber: EventSubscriber): void {
	if (subscriber.running || subscriber.disposed) return;
	subscriber.running = true;
	void (async (): Promise<void> => {
		while (!subscriber.disposed) {
			const event = subscriber.queue.shift();
			if (event === undefined) break;
			try {
				await subscriber.options.onEvent(event);
			} catch {
				// Observers are non-owning; a renderer failure cannot stop the child.
			}
		}
		subscriber.running = false;
	})();
}

function subscribe(
	record: HandleRecord,
	options: SubscribeSubagentEventsOptions,
): SubagentEventSubscription {
	const subscriber: EventSubscriber = { options, queue: [], running: false, disposed: false };
	const dispose = (): void => {
		if (subscriber.disposed) return;
		subscriber.disposed = true;
		subscriber.queue.length = 0;
		record.subscribers.delete(subscriber);
	};
	if (options.signal.aborted) dispose();
	else options.signal.addEventListener("abort", dispose, { once: true });
	record.subscribers.add(subscriber);
	return { dispose };
}

function startCompletion(
	context: ExtensionLifecycleContext,
	coordinator: Coordinator,
	spec: CompletionSubagentSpec,
): CompletionSubagentHandle {
	const id = nextId(coordinator);
	const controller = createController(context.signal);
	let status: SubagentStatus = "queued";
	let settle: (result: CompletionSubagentResult) => void = () => undefined;
	const result = new Promise<CompletionSubagentResult>((resolve) => {
		settle = resolve;
	});
	const handle: CompletionSubagentHandle = {
		id,
		mode: "completion",
		get status(): SubagentStatus {
			return status;
		},
		result,
		cancel(): void {
			cancelRecord(coordinator, record);
		},
		subscribe(options: SubscribeSubagentEventsOptions): SubagentEventSubscription {
			return subscribe(record, options);
		},
	};
	const record: HandleRecord = {
		controller,
		handle,
		subscribers: new Set(),
		started: false,
		cancelQueued: undefined,
		terminal: undefined,
	};
	record.cancelQueued = () => {
		if (record.terminal !== undefined) return;
		const terminal: CompletionSubagentResult = {
			id,
			mode: "completion",
			status: "cancelled",
			output: "",
		};
		status = terminal.status;
		record.terminal = terminal;
		settle(terminal);
		emit(record, { kind: "terminal", id, result: terminal });
		retainTerminal(coordinator, record);
	};
	registerRecord(context, coordinator, record);
	if (
		!admit(coordinator, record, async () => {
			status = "running";
			emit(record, { kind: "turn", id, state: "running" });
			let terminal: CompletionSubagentResult;
			try {
				if (controller.signal.aborted)
					terminal = { id, mode: "completion", status: "cancelled", output: "" };
				else {
					const auth = await context.extension.modelRegistry.getApiKeyAndHeaders(spec.model);
					if (!auth.ok) throw new Error(auth.error);
					const message = await completeSimple(
						spec.model,
						{
							systemPrompt: spec.systemPrompt,
							messages: spec.messages ?? [
								{ role: "user", content: spec.prompt, timestamp: Date.now() },
							],
							tools: [],
						},
						{
							signal: controller.signal,
							...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
							...(auth.headers === undefined ? {} : { headers: auth.headers }),
							...(auth.env === undefined ? {} : { env: auth.env }),
						},
					);
					const output = assistantText(message);
					terminal = controller.signal.aborted
						? { id, mode: "completion", status: "cancelled", output: "" }
						: message.stopReason === "stop" && output
							? { id, mode: "completion", status: "completed", output }
							: {
									id,
									mode: "completion",
									status: "failed",
									output: "",
									failure: "Completion produced no final text",
								};
				}
			} catch (error) {
				terminal = controller.signal.aborted
					? { id, mode: "completion", status: "cancelled", output: "" }
					: {
							id,
							mode: "completion",
							status: "failed",
							output: "",
							failure: failureMessage(error),
						};
			}
			status = terminal.status;
			record.terminal = terminal;
			settle(terminal);
			emit(record, { kind: "terminal", id, result: terminal });
			retainTerminal(coordinator, record);
		})
	) {
		releaseRecord(coordinator, record, false);
		throw new Error("Subagent pending queue is full");
	}
	return handle;
}

function startTask(
	context: ExtensionLifecycleContext,
	coordinator: Coordinator,
	spec: TaskSubagentSpec,
): TaskSubagentHandle {
	if (!Number.isSafeInteger(spec.maxTurns) || spec.maxTurns < 1)
		throw new Error("Task maxTurns must be a positive integer");
	const id = nextId(coordinator);
	const controller = createController(context.signal);
	let status: SubagentStatus = "queued";
	let settle: (result: TaskTerminalResult) => void = () => undefined;
	const result = new Promise<TaskTerminalResult>((resolve) => {
		settle = resolve;
	});
	const handle: TaskSubagentHandle = {
		id,
		mode: "task",
		get status(): SubagentStatus {
			return status;
		},
		result,
		cancel(): void {
			cancelRecord(coordinator, record);
		},
		subscribe(options: SubscribeSubagentEventsOptions): SubagentEventSubscription {
			return subscribe(record, options);
		},
	};
	const record: HandleRecord = {
		controller,
		handle,
		subscribers: new Set(),
		started: false,
		cancelQueued: undefined,
		terminal: undefined,
	};
	record.cancelQueued = () => {
		if (record.terminal !== undefined) return;
		const terminal: TaskTerminalResult = {
			id,
			mode: "task",
			status: "cancelled",
			output: "",
			softLimitReached: false,
		};
		status = terminal.status;
		record.terminal = terminal;
		settle(terminal);
		emit(record, { kind: "terminal", id, result: terminal });
		retainTerminal(coordinator, record);
	};
	registerRecord(context, coordinator, record);
	if (
		!admit(coordinator, record, async () => {
			status = "running";
			emit(record, { kind: "turn", id, state: "running" });
			let terminal: SessionTurnResult;
			let session: AgentSession | undefined;
			try {
				if (controller.signal.aborted) {
					terminal = {
						id,
						status: "cancelled",
						output: "",
						softLimitReached: false,
						usage: EMPTY_CONVERSATION_USAGE,
					};
				} else {
					session = await spec.session.create(controller.signal);
					terminal = await runSessionTurn(
						id,
						controller,
						spec.session,
						spec.prompt,
						spec.maxTurns,
						record,
						session,
					);
				}
			} catch (error) {
				terminal = controller.signal.aborted
					? {
							id,
							status: "cancelled",
							output: "",
							softLimitReached: false,
							usage: EMPTY_CONVERSATION_USAGE,
						}
					: {
							id,
							status: "failed",
							output: "",
							softLimitReached: false,
							usage: EMPTY_CONVERSATION_USAGE,
							failure: failureMessage(error),
						};
			} finally {
				session?.dispose();
			}
			const taskResult: TaskTerminalResult = { ...terminal, mode: "task" };
			status = taskResult.status;
			record.terminal = taskResult;
			settle(taskResult);
			emit(record, { kind: "terminal", id, result: taskResult });
			retainTerminal(coordinator, record);
			void Promise.resolve(spec.delivery(taskResult, controller.signal)).catch(() => undefined);
		})
	) {
		releaseRecord(coordinator, record, false);
		throw new Error("Subagent pending queue is full");
	}
	return handle;
}

interface SessionTurnResult {
	readonly id: SubagentId;
	readonly status: "completed" | "failed" | "cancelled" | "limit_reached";
	readonly output: string;
	readonly softLimitReached: boolean;
	readonly usage: ConversationUsage;
	readonly failure?: string;
}

async function runSessionTurn(
	id: SubagentId,
	controller: AbortController,
	factory: ResolvedChildSessionFactory,
	prompt: string,
	maxTurns: number,
	record: HandleRecord,
	existingSession?: AgentSession,
): Promise<SessionTurnResult> {
	let session = existingSession;
	let unsubscribe = (): void => undefined;
	let startIndex = 0;
	let turns = 0;
	let softLimitReached = false;
	try {
		session = session ?? (await factory.create(controller.signal));
		if (controller.signal.aborted) {
			void session.abort();
			return {
				id,
				status: "cancelled",
				output: "",
				softLimitReached: false,
				usage: EMPTY_CONVERSATION_USAGE,
			};
		}
		const activeSession = session;
		const forwardAbort = (): void => void activeSession.abort();
		controller.signal.addEventListener("abort", forwardAbort, { once: true });
		startIndex = activeSession.messages.length;
		unsubscribe = activeSession.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				emit(record, {
					kind: "text",
					id,
					text: lastAssistantText(activeSession, startIndex) + event.assistantMessageEvent.delta,
				});
			}
			if (event.type === "tool_execution_start")
				emit(record, { kind: "tool", id, toolName: event.toolName, state: "start" });
			if (event.type === "tool_execution_end")
				emit(record, { kind: "tool", id, toolName: event.toolName, state: "end" });
			if (event.type === "turn_end") {
				turns += 1;
				if (!softLimitReached && turns >= maxTurns) {
					softLimitReached = true;
					void activeSession.steer(
						"You have reached your turn limit. Wrap up immediately with your final answer.",
					);
				} else if (softLimitReached && turns >= maxTurns + 5) {
					void activeSession.abort();
				}
			}
		});
		await activeSession.prompt(prompt);
		const output = lastAssistantText(activeSession, startIndex);
		const usage = usageFromMessages(activeSession.messages.slice(startIndex));
		if (controller.signal.aborted)
			return { id, status: "cancelled", output: "", softLimitReached, usage };
		if (turns >= maxTurns + 5)
			return { id, status: "limit_reached", output, softLimitReached: true, usage };
		return { id, status: "completed", output, softLimitReached, usage };
	} catch (error) {
		return controller.signal.aborted
			? { id, status: "cancelled", output: "", softLimitReached, usage: EMPTY_CONVERSATION_USAGE }
			: {
					id,
					status: "failed",
					output: "",
					softLimitReached,
					usage: EMPTY_CONVERSATION_USAGE,
					failure: failureMessage(error),
				};
	} finally {
		unsubscribe();
	}
}

interface ConversationItem {
	readonly message: string;
	readonly sequence: ConversationMessageSequence;
	readonly reply: ConversationReplyConsumption;
	resolve(result: ConversationReplyResult): void;
}

function startConversation(
	context: ExtensionLifecycleContext,
	coordinator: Coordinator,
	spec: ConversationSubagentSpec,
): ConversationSubagentHandle {
	if (!Number.isSafeInteger(spec.maxTurnsPerReply) || spec.maxTurnsPerReply < 1) {
		throw new Error("Conversation maxTurnsPerReply must be a positive integer");
	}
	const id = nextId(coordinator);
	const controller = createController(context.signal);
	let status: SubagentStatus = "queued";
	let sequence = 0;
	let session: AgentSession | undefined;
	let current: ConversationItem | undefined;
	let compacting = false;
	let usage = EMPTY_CONVERSATION_USAGE;
	const pending: ConversationItem[] = [];
	let settle: (result: ConversationTerminalResult) => void = () => undefined;
	const result = new Promise<ConversationTerminalResult>((resolve) => {
		settle = resolve;
	});
	const terminal = (failure: string | undefined): void => {
		if (record.terminal !== undefined) return;
		const value: ConversationTerminalResult =
			failure === undefined
				? { id, mode: "conversation", status: "cancelled" }
				: { id, mode: "conversation", status: "failed", failure };
		status = value.status;
		record.terminal = value;
		session?.dispose();
		settle(value);
		emit(record, { kind: "terminal", id, result: value });
		retainTerminal(coordinator, record);
		for (const item of pending.splice(0)) {
			item.resolve({
				id,
				sequence: item.sequence,
				status: value.status,
				output: "",
				softLimitReached: false,
				...(failure === undefined ? {} : { failure }),
			});
		}
	};
	const schedule = (): void => {
		if (
			compacting ||
			current !== undefined ||
			pending.length === 0 ||
			record.terminal !== undefined
		)
			return;
		const item = pending.shift();
		if (item === undefined) return;
		current = item;
		const accepted = admit(coordinator, record, async () => {
			status = "running";
			emit(record, { kind: "turn", id, state: "running" });
			if (session === undefined) {
				try {
					session = await spec.session.create(controller.signal);
				} catch (error) {
					terminal(failureMessage(error));
					current = undefined;
					return;
				}
			}
			const turn = await runSessionTurn(
				id,
				controller,
				spec.session,
				item.message,
				spec.maxTurnsPerReply,
				record,
				session,
			);
			const reply: ConversationReplyResult = { ...turn, sequence: item.sequence };
			usage = addConversationUsage(usage, turn.usage);
			if (record.terminal === undefined) {
				status = "idle";
				emit(record, { kind: "turn", id, state: "idle" });
				item.resolve(reply);
				if (item.reply.kind === "delivery")
					void Promise.resolve(item.reply.delivery(reply, controller.signal)).catch(
						() => undefined,
					);
			}
			current = undefined;
			if (controller.signal.aborted) terminal(undefined);
			else schedule();
		});
		if (!accepted) {
			current = undefined;
			terminal("Subagent pending queue is full");
		}
	};
	const accept = (
		message: string,
		reply: ConversationReplyConsumption,
	): Promise<ConversationReplyResult> => {
		sequence += 1;
		const itemSequence = sequence as ConversationMessageSequence;
		const promise = new Promise<ConversationReplyResult>((resolve) => {
			pending.push({ message, sequence: itemSequence, reply, resolve });
		});
		schedule();
		return promise;
	};
	let initialResolve: (value: ConversationReplyResult) => void = () => undefined;
	const initialReply = new Promise<ConversationReplyResult>((resolve) => {
		initialResolve = resolve;
	});
	function send(
		message: string,
		options: ConversationSendOptions & { readonly reply: { readonly kind: "wait" } },
	): Promise<ConversationReplyResult>;
	function send(
		message: string,
		options: ConversationSendOptions & {
			readonly reply: {
				readonly kind: "delivery";
				readonly delivery: ConversationReplyDeliverySink;
			};
		},
	): Promise<ConversationDeliveryAcknowledgement>;
	function send(
		message: string,
		options: ConversationSendOptions,
	): Promise<ConversationReplyResult | ConversationDeliveryAcknowledgement>;
	function send(
		message: string,
		options: ConversationSendOptions,
	): Promise<ConversationReplyResult | ConversationDeliveryAcknowledgement> {
		if (!message.trim()) return Promise.reject(new Error("Conversation message must not be empty"));
		if (compacting) return Promise.reject(new Error("Conversation is compacting"));
		if (options.inputMode === "steer" && current !== undefined && session !== undefined) {
			void session.steer(message);
		}
		const reply = accept(message, options.reply);
		if (options.reply.kind === "delivery") {
			return Promise.resolve({
				id,
				sequence: sequence as ConversationMessageSequence,
				accepted: true,
			});
		}
		return reply;
	}
	const handle: ConversationSubagentHandle = {
		id,
		mode: "conversation",
		get status(): SubagentStatus {
			return status;
		},
		result,
		initialReply,
		async compact(): Promise<void> {
			if (record.terminal !== undefined) throw new Error("Conversation is terminal");
			if (status !== "idle" || current !== undefined || pending.length > 0)
				throw new Error("Conversation compaction requires an idle child");
			if (session === undefined) throw new Error("Conversation child session has not started");
			compacting = true;
			try {
				await session.compact();
			} finally {
				compacting = false;
				schedule();
			}
		},
		usage(): ConversationUsage {
			return usage;
		},
		cancel(): void {
			cancelRecord(coordinator, record);
			if (session !== undefined) void session.abort();
		},
		subscribe(options: SubscribeSubagentEventsOptions): SubagentEventSubscription {
			return subscribe(record, options);
		},
		send,
	};
	const record: HandleRecord = {
		controller,
		handle,
		subscribers: new Set(),
		started: false,
		cancelQueued: undefined,
		terminal: undefined,
	};
	record.cancelQueued = () => terminal(undefined);
	registerRecord(context, coordinator, record);
	void accept(spec.initialMessage, spec.initialReply).then(initialResolve);
	controller.signal.addEventListener("abort", () => terminal(undefined), { once: true });
	return handle;
}
