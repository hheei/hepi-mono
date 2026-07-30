import { createConnection } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHepiIntegration } from "./runtime.js";

const SOURCE = "herdr:pi";
const RETRYABLE_ERROR =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/iu;

type AgentState = "working" | "blocked" | "idle";
type SessionReference =
	| Readonly<Record<"agent_session_path", string>>
	| Readonly<Record<"agent_session_id", string>>;
type HerdrBlockedEvent = { readonly active?: unknown; readonly label?: unknown };

function connectionConfig(): { readonly socketPath: string; readonly paneId: string } | undefined {
	const socketPath = process.env.HERDR_SOCKET_PATH;
	const paneId = process.env.HERDR_PANE_ID;
	return process.env.HERDR_ENV === "1" && socketPath !== undefined && paneId !== undefined
		? { socketPath, paneId }
		: undefined;
}

function subscribeHerdrBlocked(
	pi: ExtensionAPI,
	handler: (event: HerdrBlockedEvent) => void,
): void {
	const on = Reflect.get(pi.events, "on");
	if (typeof on === "function") Reflect.apply(on, pi.events, ["herdr:blocked", handler]);
}

function send(
	socketPath: string,
	request: Readonly<Record<string, unknown>>,
	timeoutMs: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		let complete = false;
		const socket = createConnection(socketPath);
		const timeout = setTimeout(() => finish(false), timeoutMs);
		timeout.unref?.();
		const finish = (delivered: boolean): void => {
			if (complete) return;
			complete = true;
			clearTimeout(timeout);
			socket.destroy();
			resolve(delivered);
		};
		socket.once("error", () => finish(false));
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.once("data", () => finish(true));
		socket.once("end", () => finish(false));
	});
}

async function sendWithRetry(
	socketPath: string,
	request: Readonly<Record<string, unknown>>,
): Promise<void> {
	if (!(await send(socketPath, request, 500))) await send(socketPath, request, 1_500);
}

function reference(ctx: ExtensionContext): SessionReference | undefined {
	const path = ctx.sessionManager.getSessionFile();
	if (typeof path === "string" && path.startsWith("/")) return { agent_session_path: path };
	const id = ctx.sessionManager.getSessionId();
	return typeof id === "string" && id.length > 0 ? { agent_session_id: id } : undefined;
}

function errorMessage(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		const value = message as {
			readonly role?: unknown;
			readonly stopReason?: unknown;
			readonly errorMessage?: unknown;
		};
		if (value.role !== "assistant" || value.stopReason !== "error") continue;
		return typeof value.errorMessage === "string" && value.errorMessage.length > 0
			? value.errorMessage
			: "provider error";
	}
	return undefined;
}

export function registerHerdrAgentState(pi: ExtensionAPI): void {
	const config = connectionConfig();
	if (config === undefined) return;
	registerHepiIntegration(pi, "herdr-agent-state", (isCurrent) => {
		let sequence = Date.now() * 1_000;
		let session: SessionReference | undefined;
		let agentActive = false;
		let failure: string | undefined;
		let blocked = 0;
		let blockedMessage: string | undefined;
		let last: { readonly state: AgentState; readonly message?: string } | undefined;
		let sending = false;
		let pending:
			| { readonly state: AgentState; readonly message?: string; readonly sequence: number }
			| undefined;

		const nextSequence = (): number => {
			sequence += 1;
			return sequence;
		};
		const state = (): { readonly state: AgentState; readonly message?: string } => {
			if (blocked > 0)
				return blockedMessage === undefined
					? { state: "blocked" }
					: { state: "blocked", message: blockedMessage };
			if (failure !== undefined) return { state: "blocked", message: failure };
			return agentActive ? { state: "working" } : { state: "idle" };
		};
		const deliver = async (): Promise<void> => {
			if (sending) return;
			sending = true;
			try {
				while (pending !== undefined) {
					const next = pending;
					pending = undefined;
					await sendWithRetry(config.socketPath, {
						id: `${SOURCE}:${next.sequence}`,
						method: "pane.report_agent",
						params: {
							pane_id: config.paneId,
							source: SOURCE,
							agent: "pi",
							state: next.state,
							message: next.message,
							seq: next.sequence,
							...(session ?? {}),
						},
					});
				}
			} finally {
				sending = false;
				if (pending !== undefined && isCurrent()) void deliver();
			}
		};
		const publish = (force = false): void => {
			if (!isCurrent()) return;
			const next = state();
			if (!force && next.state === last?.state && next.message === last.message) return;
			last = next;
			pending = { ...next, sequence: nextSequence() };
			void deliver();
		};
		const reportSession = (): void => {
			if (session === undefined) return;
			void sendWithRetry(config.socketPath, {
				id: `${SOURCE}:session:${nextSequence()}`,
				method: "pane.report_agent_session",
				params: {
					pane_id: config.paneId,
					source: SOURCE,
					agent: "pi",
					seq: nextSequence(),
					...session,
				},
			});
		};

		subscribeHerdrBlocked(pi, (event) => {
			if (!isCurrent()) return;
			if (event.active === true) {
				blocked += 1;
				blockedMessage = typeof event.label === "string" ? event.label : undefined;
			} else {
				blocked = Math.max(0, blocked - 1);
				if (blocked === 0) blockedMessage = undefined;
			}
			publish();
		});
		pi.on("session_start", (_event, ctx) => {
			if (!isCurrent() || !ctx.hasUI) return;
			session = reference(ctx);
			agentActive = !ctx.isIdle();
			failure = undefined;
			reportSession();
			publish(true);
		});
		pi.on("agent_start", (_event, ctx) => {
			if (!isCurrent()) return;
			session = reference(ctx);
			agentActive = true;
			failure = undefined;
			reportSession();
			publish();
		});
		pi.on("agent_end", (event) => {
			if (!isCurrent()) return;
			const message = errorMessage(event.messages);
			if (message !== undefined && !RETRYABLE_ERROR.test(message)) failure = message;
		});
		pi.on("agent_settled", () => {
			if (!isCurrent()) return;
			agentActive = false;
			publish();
		});
		pi.on("session_shutdown", (event) => {
			if (!isCurrent()) return;
			if (event.reason === "quit") {
				void sendWithRetry(config.socketPath, {
					id: `${SOURCE}:release:${nextSequence()}`,
					method: "pane.release_agent",
					params: { pane_id: config.paneId, source: SOURCE, agent: "pi", seq: nextSequence() },
				});
			}
		});
		return () => {
			pending = undefined;
		};
	});
}
