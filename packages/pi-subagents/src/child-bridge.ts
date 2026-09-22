/**
 * Child-branch session binding. The TUI process may /reload the same session,
 * /quit, or switch to an unrelated session B. Only a confirmed leave of A
 * unbinds the bridge; shutdown or switch requests alone do not.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { registerChildNudge } from "./child-nudge.js";
import { connectWithRetry, RunnerConnection, sendLifecycleToRunner } from "./connector.js";
import type { ChildIdentity } from "./domain.js";
import { CHILD_AGENT_ENV_KEY, CHILD_SESSION_ENV_KEY, isRecord } from "./domain.js";
import { PauseGate } from "./pause-gate.js";
import { CANCEL_PAUSE_EVENT, PAUSE_EVENT } from "./protocol.js";
import { registerChildTools } from "./tools.js";
import { createChildIdentityWidget } from "./widget.js";

const USER_INTERRUPT_STOP_REASON = "aborted";

export type ChildLifecycleKind = "left_session" | "tui_quit" | "user_interrupt";

export interface ChildBridgeState {
	bound: boolean;
	boundSessionId: string;
	readonly gate: PauseGate;
}

export interface ChildPauseSocket {
	connect?(signal?: AbortSignal): Promise<void>;
	reportPaused(generation: number, signal?: AbortSignal): Promise<void>;
	onEvent(listener: (event: unknown) => void): () => void;
	close(): void;
}

export interface ChildBridgeOptions {
	readonly pauseSocket?: ChildPauseSocket;
	readonly gate?: PauseGate;
	readonly connect?: (socket: ChildPauseSocket, signal?: AbortSignal) => Promise<void>;
}

export function boundSessionIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[CHILD_SESSION_ENV_KEY];
	return typeof value === "string" && value !== "" ? value : undefined;
}

export function shouldLeaveBoundSession(params: {
	readonly boundSessionId: string;
	readonly currentSessionId: string;
	readonly reason: SessionStartEvent["reason"];
}): boolean {
	if (params.currentSessionId === params.boundSessionId) return false;
	return params.reason === "new" || params.reason === "resume" || params.reason === "fork";
}

export function isConfirmedUserInterrupt(
	messages: readonly { role?: string; stopReason?: string }[] | undefined,
): boolean {
	if (messages === undefined) return false;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return message.stopReason === USER_INTERRUPT_STOP_REASON;
	}
	return false;
}

export function lastActivityText(
	messages: readonly { role?: string; content?: unknown }[] | undefined,
): string {
	if (messages === undefined) return "";
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		const text = messageText(message?.content);
		if (text !== "") return text;
	}
	return "";
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const value = isRecord(part) ? part : undefined;
			return value?.type === "text" && typeof value.text === "string" ? value.text : "";
		})
		.join("")
		.trim();
}

function currentSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function reportLifecycle(
	identity: ChildIdentity,
	kind: ChildLifecycleKind,
	sessionId: string,
	message?: string,
): void {
	void sendLifecycleToRunner(identity, {
		type: "child_lifecycle",
		parentSessionId: identity.parentSessionId,
		childId: identity.subagentId,
		runtimeIdentity: identity.runtimeIdentity,
		kind,
		sessionId,
		...(message === undefined || message === "" ? {} : { message }),
	}).catch((error: unknown) => {
		console.error(
			`pi-subagents: failed to report ${kind}: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
}

/** Registers the child-only tools, identity widget, and session-leave reporting. */
export function registerChildBridge(
	pi: ExtensionAPI,
	identity: ChildIdentity,
	options: ChildBridgeOptions = {},
): ChildBridgeState {
	const boundSessionId = boundSessionIdFromEnv() ?? "";
	const gate = options.gate ?? new PauseGate();
	const state: ChildBridgeState = {
		bound: boundSessionId !== "",
		boundSessionId,
		gate,
	};
	const nudge = registerChildNudge(pi);
	registerChildTools(pi, identity, {
		onReport: () => nudge.markReported(),
		isBound: (sessionId) =>
			state.bound && (state.boundSessionId === "" || sessionId === state.boundSessionId),
	});
	const stop = new AbortController();
	const pauseSocket = options.pauseSocket ?? openChildPauseSocket(identity);
	pauseSocket.onEvent((event) => {
		if (!isRecord(event) || typeof event.type !== "string") return;
		if (event.type === PAUSE_EVENT && typeof event.generation === "number") {
			gate.request(event.generation);
			return;
		}
		if (event.type === CANCEL_PAUSE_EVENT) {
			gate.cancel(typeof event.generation === "number" ? event.generation : undefined);
		}
	});
	const connectPause = options.connect ?? defaultConnectPause;
	void connectPause(pauseSocket, stop.signal).catch((error: unknown) => {
		console.error(
			`pi-subagents: pause bridge failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
	let identityWidget: { dispose(): void } | undefined;
	const disposeWidget = (): void => {
		identityWidget?.dispose();
		identityWidget = undefined;
	};
	const showIdentity = (ctx: ExtensionContext): void => {
		disposeWidget();
		if (!state.bound || ctx.mode !== "tui") return;
		const tools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
		identityWidget = createChildIdentityWidget(pi, ctx, stop.signal, {
			agent: process.env[CHILD_AGENT_ENV_KEY] ?? "",
			toolCount: tools.length,
		});
	};
	const leave = (sessionId: string): void => {
		if (!state.bound) return;
		state.bound = false;
		gate.cancel();
		pauseSocket.close();
		disposeWidget();
		nudge.dispose();
		reportLifecycle(identity, "left_session", sessionId);
	};

	pi.on("session_start", (event, ctx) => {
		const sessionId = currentSessionId(ctx);
		if (!state.bound && state.boundSessionId === "") {
			state.boundSessionId = sessionId;
			state.bound = true;
			showIdentity(ctx);
			return;
		}
		if (
			shouldLeaveBoundSession({
				boundSessionId: state.boundSessionId,
				currentSessionId: sessionId,
				reason: event.reason,
			})
		) {
			leave(sessionId);
			return;
		}
		if (state.bound && sessionId === state.boundSessionId) showIdentity(ctx);
	});
	pi.on("session_shutdown", (event: SessionShutdownEvent) => {
		if (event.reason === "quit" && state.bound) {
			reportLifecycle(identity, "tui_quit", state.boundSessionId);
		}
		disposeWidget();
		if (
			event.reason === "quit" ||
			event.reason === "new" ||
			event.reason === "resume" ||
			event.reason === "fork"
		) {
			nudge.dispose();
		}
		if (event.reason === "quit") {
			gate.cancel();
			pauseSocket.close();
			stop.abort();
		}
	});
	pi.on("agent_end", (event, ctx) => {
		if (!state.bound || currentSessionId(ctx) !== state.boundSessionId) return;
		const messages = Array.isArray(event.messages) ? event.messages : undefined;
		if (!isConfirmedUserInterrupt(messages)) return;
		const activity = lastActivityText(messages);
		reportLifecycle(
			identity,
			"user_interrupt",
			state.boundSessionId,
			activity === ""
				? "Task is unfinished and waiting for user intent."
				: `Task is unfinished and waiting for user intent. Last activity: ${activity}`,
		);
	});
	pi.on("turn_end", async () => {
		if (!state.bound || !gate.holding) return;
		const generation = gate.generation;
		try {
			await pauseSocket.reportPaused(generation, stop.signal);
		} catch (error: unknown) {
			if (stop.signal.aborted) return;
			console.error(
				`pi-subagents: failed to ack pause: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await gate.wait(stop.signal);
	});
	return state;
}

function openChildPauseSocket(identity: ChildIdentity): ChildPauseSocket {
	const connection = new RunnerConnection({
		endpoint: identity.endpoint,
		identity,
		token: identity.token,
		role: "bridge",
	});
	return {
		connect: (signal) => connection.connect(signal),
		async reportPaused(generation, signal) {
			await connection.request(
				"report_paused",
				{
					type: "report_paused",
					parentSessionId: identity.parentSessionId,
					childId: identity.subagentId,
					runtimeIdentity: identity.runtimeIdentity,
					generation,
				},
				signal === undefined ? {} : { signal },
			);
		},
		onEvent: (listener) => connection.onEvent(listener),
		close: () => connection.close(),
	};
}

async function defaultConnectPause(socket: ChildPauseSocket, signal?: AbortSignal): Promise<void> {
	if (socket.connect === undefined) return;
	await connectWithRetry(
		{ connect: (abort) => socket.connect?.(abort) ?? Promise.resolve() },
		signal === undefined ? {} : { signal },
	);
}
