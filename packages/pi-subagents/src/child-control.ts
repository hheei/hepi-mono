/**
 * Child-side control plane.
 *
 * The parent drives a child, and the child reports back, over one bridge connection. Every parent
 * request is executed with this process's own Pi primitives, so a child presented in a host panel
 * and a child running headless are controlled identically and no second transport (an RPC writer,
 * a pause handshake) has to be kept in sync with the child's real state.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage, isRecord } from "@hheei/pi-ext-core";
import { ChildBridgeClient, type ChildBridgeRequest } from "./bridge-client.js";
import type { ChildIdentity } from "./domain.js";
import { BridgeError, type ChildInputSource } from "./protocol.js";
import { FORWARDED_PI_EVENT_TYPES, shouldForwardPiEvent } from "./rpc-events.js";
import { assistantUpdatePhase } from "./state.js";

const CHILD_INPUT_SOURCES: readonly string[] = ["interactive", "extension", "rpc"];

export interface ChildControl {
	/**
	 * Opens the bridge connection for the session this process is now serving. Called from
	 * `session_start`, so a connected bridge always means a live, ready child session.
	 */
	start(context?: ExtensionContext): void;
	/**
	 * Sends a report the parent must acknowledge: `contact_parent`, `task_result`. An aborted
	 * signal gives up on it, so a cancelled tool call does not wait for an unreachable parent.
	 */
	report(operation: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
	/** Sends an advisory frame: child lifecycle signals. */
	sendEvent(event: unknown): void;
	dispose(): void;
}

export interface ChildControlOptions {
	/** The parent's bridge socket. */
	readonly endpoint: string;
	readonly identity: ChildIdentity;
	/**
	 * False while this process is serving a session the parent did not launch. A bridge belongs to
	 * one child, so whatever session the process serves next must neither forward its events nor
	 * count as that child's input.
	 */
	readonly isActive?: () => boolean;
	readonly diagnose?: (message: string) => void;
}

/** The source of a Pi input event, when it is one the parent is allowed to hear about. */
export function childInputSource(event: unknown): ChildInputSource | undefined {
	if (!isRecord(event) || typeof event.source !== "string") return undefined;
	return CHILD_INPUT_SOURCES.includes(event.source)
		? (event.source as ChildInputSource)
		: undefined;
}

/** Reads the `{ message }` payload both prompt-shaped operations use. */
export function promptMessage(payload: unknown): string {
	if (!isRecord(payload) || typeof payload.message !== "string" || payload.message.trim() === "") {
		throw new BridgeError("invalid_payload", "A prompt request requires a non-empty message");
	}
	return payload.message;
}

/**
 * Answers a parent request with this child's Pi state. Idleness is the child's own answer: the
 * parent never infers it from how long ago it last heard something.
 */
export function childState(ctx: ExtensionContext): Record<string, unknown> {
	const sessionPath = ctx.sessionManager.getSessionFile();
	return {
		idle: ctx.isIdle(),
		pendingMessages: ctx.hasPendingMessages(),
		sessionId: ctx.sessionManager.getSessionId(),
		...(sessionPath ? { sessionPath } : {}),
	};
}

/**
 * The dedup key for a streaming update: its phase plus the tool it names. Two deltas with the same
 * key are the same telemetry, so only the first is forwarded while the parent is listening.
 */
function assistantPhaseKey(event: Record<string, unknown>): string | undefined {
	const phase = assistantUpdatePhase(event.assistantMessageEvent, event.message);
	if (phase === undefined) return undefined;
	return phase.toolName === undefined ? phase.kind : `${phase.kind}:${phase.toolName}`;
}

/** Text kept from a message part: enough for the parent's summary, never the whole payload. */
const BRIDGE_MESSAGE_TEXT_LIMIT = 200;
/** Text kept from a tool result part: the parent shows tool activity, not tool output. */
const BRIDGE_TOOL_TEXT_LIMIT = 1000;
/** Content parts kept per message, so a frame stays bounded no matter how long the stream runs. */
const BRIDGE_MAX_CONTENT_PARTS = 32;

/**
 * Reduces one content part to what the parent's projector reads. Text is truncated, image data is
 * replaced by a marker, and a tool call keeps its name but not its arguments: the parent projects
 * turn-level activity, so it never needs the payload that produced it.
 */
function compactContentPart(part: unknown, textLimit: number): unknown {
	if (!isRecord(part)) return part;
	if (part.type === "text" && typeof part.text === "string") {
		return part.text.length > textLimit
			? { ...part, text: `${part.text.slice(0, textLimit)}\n... [truncated for bridge event]` }
			: part;
	}
	if (part.type === "image") {
		return {
			type: "image",
			mimeType: part.mimeType,
			data: "[image omitted for bridge event]",
		};
	}
	if (part.type === "toolCall") {
		return {
			type: "toolCall",
			...(typeof part.id === "string" ? { id: part.id } : {}),
			...(typeof part.name === "string" ? { name: part.name } : {}),
		};
	}
	return typeof part.type === "string" ? { type: part.type } : {};
}

function compactContent(content: unknown, textLimit: number): unknown[] | undefined {
	if (!Array.isArray(content)) return undefined;
	return content
		.slice(0, BRIDGE_MAX_CONTENT_PARTS)
		.map((part) => compactContentPart(part, textLimit));
}

/** Keeps only the turn-level message fields the projector reads, dropping the rest. */
function compactMessage(message: unknown, textLimit: number): Record<string, unknown> | undefined {
	const value = isRecord(message) ? message : undefined;
	if (value === undefined) return undefined;
	const content = compactContent(value.content, textLimit);
	return {
		...(typeof value.role === "string" ? { role: value.role } : {}),
		...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}),
		...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
		...(content === undefined ? {} : { content }),
	};
}

/**
 * Compacts an advisory event to the telemetry the parent projects before it is serialized and
 * pushed over the bridge. A streaming update carries the whole partial message — text, tool
 * arguments, the accumulating `partial` — which is what the parent neither reads nor needs; only
 * the phase metadata (type, content index) and the tool name survive, so a frame stays far below
 * the protocol limit under any payload size.
 */
export function sanitizeEventForBridge(event: unknown): unknown {
	if (!isRecord(event)) return event;
	if (event.type === "message_update") {
		const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
		const message = compactMessage(event.message, BRIDGE_MESSAGE_TEXT_LIMIT);
		return {
			type: "message_update",
			...(message === undefined ? {} : { message }),
			...(update === undefined
				? {}
				: {
						assistantMessageEvent: {
							...(typeof update.type === "string" ? { type: update.type } : {}),
							...(typeof update.contentIndex === "number"
								? { contentIndex: update.contentIndex }
								: {}),
						},
					}),
		};
	}
	if (event.type === "tool_execution_start") {
		return {
			type: "tool_execution_start",
			...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
			...(typeof event.toolCallId === "string" ? { toolCallId: event.toolCallId } : {}),
		};
	}
	if (event.type === "tool_execution_end" && isRecord(event.result)) {
		const content = compactContent(event.result.content, BRIDGE_TOOL_TEXT_LIMIT);
		return {
			...event,
			result: {
				...(content === undefined ? {} : { content }),
				...(typeof event.result.isError === "boolean" ? { isError: event.result.isError } : {}),
			},
		};
	}
	if (event.type === "turn_end") {
		const message = compactMessage(event.message, BRIDGE_MESSAGE_TEXT_LIMIT);
		return {
			type: "turn_end",
			...(typeof event.turnIndex === "number" ? { turnIndex: event.turnIndex } : {}),
			...(message === undefined ? {} : { message }),
		};
	}
	if (event.type === "agent_end" || event.type === "agent_settled") {
		const messages = Array.isArray(event.messages) ? event.messages : undefined;
		const last = messages?.[messages.length - 1];
		const message = compactMessage(last ?? event.message, BRIDGE_MESSAGE_TEXT_LIMIT);
		return {
			type: event.type,
			...(event.type === "agent_settled" ? { aborted: event.aborted } : {}),
			...(message === undefined ? {} : { message, messages: [message] }),
		};
	}
	return event;
}

/**
 * Registers the bridge connection and the Pi primitives behind it. The connection keeps dialing
 * while the parent is away, so a panel child survives a parent restart without losing its reports.
 */
export function registerChildControl(pi: ExtensionAPI, options: ChildControlOptions): ChildControl {
	const isActive = options.isActive ?? (() => true);
	let ctx: ExtensionContext | undefined;
	const requireContext = (): ExtensionContext => {
		if (ctx === undefined) {
			throw new BridgeError("session_not_ready", "This child has no active Pi session yet");
		}
		return ctx;
	};
	const deliverPrompt = (
		payload: unknown,
		deliverAs: "steer" | "followUp" | undefined,
	): Record<string, unknown> => {
		const message = promptMessage(payload);
		// A message needs a session to land in: while the process is between sessions the parent
		// hears that instead of a silent drop.
		requireContext();
		if (deliverAs !== undefined) pi.sendUserMessage(message, { deliverAs });
		else pi.sendUserMessage(message);
		return { accepted: true };
	};
	const handleRequest = async (request: ChildBridgeRequest): Promise<unknown> => {
		if (!isActive()) {
			// The process serves another session now, so it is not this child's runtime: answering
			// would drive a session the parent never launched.
			throw new BridgeError(
				"inactive_session",
				"This process no longer serves the delegated session",
			);
		}
		switch (request.operation) {
			case "prompt":
				return deliverPrompt(request.payload, undefined);
			case "steer":
				return deliverPrompt(request.payload, "steer");
			case "follow_up":
				return deliverPrompt(request.payload, "followUp");
			case "get_state":
				return childState(requireContext());
			case "get_entries": {
				const sm = requireContext().sessionManager;
				const branch = typeof sm.getBranch === "function" ? sm.getBranch() : undefined;
				const entries = Array.isArray(branch) && branch.length > 0 ? branch : sm.getEntries();
				return { entries };
			}
			case "abort":
				requireContext().abort();
				return { accepted: true };
			case "shutdown":
				requireContext().shutdown();
				return { accepted: true };
			default:
				throw new BridgeError(
					"unsupported_operation",
					`This child does not implement ${request.operation}`,
				);
		}
	};
	const dispose: Array<() => void> = [];
	let currentPhase: string | undefined;
	/** The compact event carrying the current phase, resent when the parent reconnects. */
	let lastPhaseEvent: unknown;
	const phaseResetEvents: readonly string[] = [
		"agent_start",
		"agent_end",
		"turn_start",
		"turn_end",
		"agent_settled",
		"tool_execution_start",
		"tool_execution_end",
	];
	const client = new ChildBridgeClient({
		endpoint: options.endpoint,
		identity: options.identity,
		handleRequest,
		...(options.diagnose === undefined ? {} : { diagnose: options.diagnose }),
		onConnect: () => {
			// A reconnected parent knows nothing of the phase this child reached while the socket was
			// down, so the current compact phase is resent before new deltas arrive.
			if (lastPhaseEvent !== undefined) client.sendEvent(lastPhaseEvent);
		},
	});

	// `pi.on` is declared as literal-name overloads, so a loop over the forwarded event types cannot
	// be typed through them; every name in FORWARDED_PI_EVENT_TYPES is a real Pi event.
	const onPiEvent = pi.on as (
		event: string,
		handler: (event: unknown, context: ExtensionContext) => void,
	) => () => void;
	for (const type of FORWARDED_PI_EVENT_TYPES) {
		dispose.push(
			onPiEvent(type, (event) => {
				if (!isActive()) return;
				if (!shouldForwardPiEvent(event)) return;
				const compact = sanitizeEventForBridge(event);

				if (isRecord(event)) {
					if (typeof event.type === "string" && phaseResetEvents.includes(event.type)) {
						currentPhase = undefined;
						lastPhaseEvent = undefined;
					} else if (event.type === "message_update") {
						const phase = assistantPhaseKey(event);
						if (phase !== undefined) {
							lastPhaseEvent = compact;
							// While the parent is listening, repetitive deltas in the same phase are dropped to
							// prevent socket floods. A disconnected parent suppresses nothing: the phase is
							// resent from `onConnect` instead, so a dropped delta cannot hide it.
							if (phase === currentPhase && client.connected) return;
							currentPhase = phase;
						}
					}
				}

				client.sendEvent(compact);
			}),
		);
	}
	dispose.push(
		pi.on("input", (event) => {
			if (!isActive()) return;
			const source = childInputSource(event);
			if (source !== undefined) client.sendChildInput(source);
		}),
	);
	dispose.push(
		pi.on("session_start", (_event, context) => {
			ctx = context;
		}),
	);
	dispose.push(
		pi.on("session_shutdown", () => {
			ctx = undefined;
		}),
	);
	let started = false;
	return {
		start(context) {
			if (context !== undefined) ctx = context;
			if (started) return;
			started = true;
			client.start();
		},
		report: (operation, payload, signal) => client.sendReport(operation, payload, signal),
		sendEvent: (event) => client.sendEvent(event),
		dispose: () => {
			for (const off of dispose) {
				try {
					off();
				} catch (error) {
					options.diagnose?.(`could not remove a bridge listener: ${errorMessage(error)}`);
				}
			}
			started = false;
			client.close();
		},
	};
}
