import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext } from "./lifecycle.js";

declare const subagentIdBrand: unique symbol;
declare const conversationMessageSequenceBrand: unique symbol;

/** Opaque core-generated identifier for one parent-session-scoped operation. */
export type SubagentId = string & { readonly [subagentIdBrand]: true };

/** Monotonic identifier for one message accepted by a Conversation handle. */
export type ConversationMessageSequence = number & {
	readonly [conversationMessageSequenceBrand]: true;
};

export type SubagentMode = "completion" | "task" | "conversation";

export type SubagentStatus =
	| "queued"
	| "running"
	| "idle"
	| "completed"
	| "failed"
	| "cancelled"
	| "limit_reached";

export interface ConfigureSubagentCoordinatorOptions {
	/** Positive integer cap shared by all active child turns in this Pi runtime. */
	readonly maxActiveTurns: number;
}

export interface CompletionSubagentSpec {
	readonly mode: "completion";
	/** Resolved model. Core reads its credential through the lifecycle model registry. */
	readonly model: Model<Api>;
	readonly prompt: string;
	readonly systemPrompt: string;
	readonly thinkingLevel: ThinkingLevel;
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
	readonly mode: "task";
	/** Fully resolved Pi child-session policy; core invokes `createAgentSession` with it. */
	readonly session: CreateAgentSessionOptions;
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
	readonly mode: "conversation";
	/** Fully resolved Pi child-session policy; core invokes `createAgentSession` with it. */
	readonly session: CreateAgentSessionOptions;
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

export type SubagentHandle =
	| CompletionSubagentHandle
	| TaskSubagentHandle
	| ConversationSubagentHandle;

/**
 * Installs the sole live root coordinator configuration for this lifecycle.
 * A second live owner is a collision error; lifecycle abort releases ownership.
 */
export function configureSubagentCoordinator(
	_context: ExtensionLifecycleContext,
	_options: ConfigureSubagentCoordinatorOptions,
): void {
	throw new Error("@hheei/pi-ext-core subagent execution is not implemented");
}

/**
 * Starts one root-session-scoped completion, task, or conversation. The shared
 * coordinator must already be configured by its lifecycle owner.
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
	_context: ExtensionLifecycleContext,
	_spec: SubagentSpec,
): SubagentHandle {
	throw new Error("@hheei/pi-ext-core subagent execution is not implemented");
}

/** Returns a retained terminal handle for this parent lifecycle, if it still exists. */
export function lookupSubagent(
	_context: ExtensionLifecycleContext,
	_id: SubagentId,
): SubagentHandle | undefined {
	throw new Error("@hheei/pi-ext-core subagent execution is not implemented");
}

/** Explicitly retries delivery of one retained Task result without rerunning its execution. */
export function redeliverTask(
	_context: ExtensionLifecycleContext,
	_id: SubagentId,
	_delivery: TaskTerminalDeliverySink,
): Promise<void> {
	throw new Error("@hheei/pi-ext-core subagent execution is not implemented");
}
