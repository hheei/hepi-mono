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
 * Truncates bulky data (like huge file reads, grep blocks, or base64 images) in advisory events
 * before they are serialized and pushed over the bridge. The parent projector only requires
 * turn-level signals, not multi-megabyte payloads.
 */
export function sanitizeEventForBridge(event: unknown): unknown {
	if (!isRecord(event)) return event;
	if (event.type === "tool_execution_end" && isRecord(event.result)) {
		const result = event.result;
		if (Array.isArray(result.content)) {
			const sanitizedContent = result.content.map((part) => {
				if (
					isRecord(part) &&
					part.type === "text" &&
					typeof part.text === "string" &&
					part.text.length > 2000
				) {
					return {
						...part,
						text: `${part.text.slice(0, 1000)}\n... [truncated for bridge event]`,
					};
				}
				if (isRecord(part) && part.type === "image") {
					return {
						type: "image",
						mimeType: part.mimeType,
						data: "[image omitted for bridge event]",
					};
				}
				return part;
			});
			return { ...event, result: { ...result, content: sanitizedContent } };
		}
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
			case "get_entries":
				return { entries: requireContext().sessionManager.getEntries() };
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
	const client = new ChildBridgeClient({
		endpoint: options.endpoint,
		identity: options.identity,
		handleRequest,
		...(options.diagnose === undefined ? {} : { diagnose: options.diagnose }),
	});
	const dispose: Array<() => void> = [];
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
				if (shouldForwardPiEvent(event)) client.sendEvent(sanitizeEventForBridge(event));
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
