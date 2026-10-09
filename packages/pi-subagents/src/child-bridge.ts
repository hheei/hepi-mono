/**
 * Child-branch session binding. The TUI process may /reload the same session,
 * /quit, or switch to an unrelated session B. Only a confirmed leave of A
 * unbinds the bridge; shutdown or switch requests alone do not.
 *
 * Everything the parent asks of this child arrives over the bridge connection created here, and
 * every Pi event, lifecycle notice and report this child produces leaves over that same connection.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { type ChildControl, registerChildControl } from "./child-control.js";
import type { ChildIdentity } from "./domain.js";
import { CHILD_AGENT_ENV_KEY, CHILD_SESSION_ENV_KEY, CHILD_TITLE_ENV_KEY } from "./domain.js";
import { registerChildTools } from "./tools.js";

export type ChildLifecycleKind = "left_session" | "tui_quit" | "user_interrupt";

export interface ChildBridgeState {
	bound: boolean;
	boundSessionId: string;
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

/** Every delegated session title carries this marker, so a child session is recognizable at a glance. */
const SUBAGENT_TITLE_MARKER = "🤖";

/**
 * The child's session title. A delegated session is kept out of the human's session list by
 * writing it into the child-scoped session directory; this title is what identifies the session
 * when someone opens a child session deliberately.
 */
export function childSessionTitle(params: {
	/** Title requested at spawn; an absent or empty one is derived from the child itself. */
	readonly title: string | undefined;
	readonly subagentId: string;
	readonly agent: string;
}): string {
	const title = params.title?.trim();
	if (title !== undefined && title !== "") return `${SUBAGENT_TITLE_MARKER} ${title}`;
	const agent = params.agent.trim();
	return agent === ""
		? `${SUBAGENT_TITLE_MARKER} ${params.subagentId}`
		: `${SUBAGENT_TITLE_MARKER} ${agent} · ${params.subagentId}`;
}

/** Only a session a human operates owns a user-visible quit. */
/**
 * The shutdown reasons that end this process's bridge connection. A reload loads this extension
 * again in a fresh instance: the old client has to stop dialing, or two clients would compete for
 * one bridge connection. The session binding survives either way.
 */
export function shouldDisposeBridge(reason: SessionShutdownEvent["reason"]): boolean {
	return reason === "quit" || reason === "reload";
}

export function shouldReportTuiQuit(params: {
	readonly reason: SessionShutdownEvent["reason"];
	readonly mode: ExtensionContext["mode"];
}): boolean {
	return params.reason === "quit" && params.mode === "tui";
}

function currentSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

export interface ChildBridgeOptions {
	/** Where connection problems are reported; defaults to this process's stderr. */
	readonly diagnose?: (message: string) => void;
}

/** Registers the child-only tools, identity widget, bridge control plane and session reporting. */
export function registerChildBridge(
	pi: ExtensionAPI,
	identity: ChildIdentity,
	options: ChildBridgeOptions = {},
): ChildBridgeState {
	const boundSessionId = boundSessionIdFromEnv() ?? "";
	const state: ChildBridgeState = {
		bound: boundSessionId !== "",
		boundSessionId,
	};
	const isBound = (sessionId: string): boolean =>
		state.bound && (state.boundSessionId === "" || sessionId === state.boundSessionId);
	// File-configured MCP servers can connect even when memory's automatic registration is
	// disabled. A prefix gate also covers future tools and nested codemode calls.
	pi.on("tool_call", (event) => {
		if (event.toolName.startsWith("mcp__hindsight__")) {
			return { block: true, reason: "Hindsight memory is unavailable in delegated processes." };
		}
		return undefined;
	});
	const control: ChildControl = registerChildControl(pi, {
		endpoint: identity.endpoint,
		identity,
		isActive: () => state.bound,
		diagnose:
			options.diagnose ??
			((message) => {
				if (process.env.DEBUG || process.env.PI_SUBAGENTS_DEBUG) {
					console.error(`pi-subagents: ${message}`);
				}
			}),
	});
	const report = async (
		operation: string,
		payload: unknown,
		signal?: AbortSignal,
	): Promise<unknown> => await control.report(operation, payload, signal);
	registerChildTools(pi, identity, {
		report,
		isBound,
	});
	const stop = new AbortController();
	const reportLifecycle = (kind: ChildLifecycleKind, sessionId: string, message?: string): void => {
		control.sendEvent({
			type: "child_lifecycle",
			parentSessionId: identity.parentSessionId,
			childId: identity.subagentId,
			runtimeIdentity: identity.runtimeIdentity,
			kind,
			sessionId,
			...(message === undefined || message === "" ? {} : { message }),
		});
	};
	const leave = (sessionId: string): void => {
		if (!state.bound) return;
		state.bound = false;
		reportLifecycle("left_session", sessionId);
		// This process serves another session from now on, so it is never this child again: closing the
		// bridge for good is what keeps a parent that missed the notice (its socket was down, or it
		// restarted) from adopting this process — and later stopping the panel the human is using.
		control.dispose();
	};

	/**
	 * A launch already knows which session it was started for, so the title is written the first
	 * time this process sees that session. One write per session is enough: the name lives in the
	 * session file, and re-appending it on every reload would only add entries.
	 */
	let titledSessionId = "";
	const titleSession = (sessionId: string): void => {
		if (titledSessionId === sessionId) return;
		titledSessionId = sessionId;
		pi.setSessionName(
			childSessionTitle({
				title: process.env[CHILD_TITLE_ENV_KEY],
				subagentId: identity.subagentId,
				agent: process.env[CHILD_AGENT_ENV_KEY] ?? "",
			}),
		);
	};
	pi.on("session_start", (event, ctx) => {
		const sessionId = currentSessionId(ctx);
		// Connecting here is what makes a live bridge mean a live session: the parent's first request
		// can never arrive before this process has a session to answer it with.
		control.start(ctx);
		if (ctx.ui?.setToolsExpanded) {
			ctx.ui.setToolsExpanded(false);
		}
		if (!state.bound && state.boundSessionId === "") {
			state.boundSessionId = sessionId;
			state.bound = true;
			titleSession(sessionId);
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
		if (state.bound && sessionId === state.boundSessionId) {
			titleSession(sessionId);
		}
	});
	pi.on("session_shutdown", (event: SessionShutdownEvent, ctx: ExtensionContext) => {
		if (state.bound && shouldReportTuiQuit({ reason: event.reason, mode: ctx.mode })) {
			reportLifecycle("tui_quit", state.boundSessionId);
		}
		if (shouldDisposeBridge(event.reason)) {
			// The process is going away (quit) or this extension is about to be loaded again (reload):
			// either way this client stops dialing, and the reloaded bridge serves the same session.
			stop.abort();
			control.dispose();
		}
	});
	pi.on("agent_settled", (event, ctx) => {
		if (!state.bound || currentSessionId(ctx) !== state.boundSessionId) return;
		if (!event.aborted) return;
		reportLifecycle(
			"user_interrupt",
			state.boundSessionId,
			"Task is unfinished and waiting for user intent.",
		);
	});
	return state;
}
