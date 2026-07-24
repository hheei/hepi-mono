import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	comparePayloadSnapshots,
	type PayloadSnapshot,
	requestLogSnapshot,
	snapshotProviderPayload,
} from "./probe.js";

interface SessionState {
	readonly logPath: string;
	previous: PayloadSnapshot | undefined;
	requestSequence: number;
	readonly pendingRequests: number[];
	writeFailed: boolean;
}

export const DEBUG_GUIDE_URL =
	"https://github.com/hheei/hepi-mono/blob/main/packages/pi-cache-debug/DEBUGGING.md";

export interface CacheDebugOptions {
	readonly logPath?: string;
}

export function registerCacheDebug(pi: ExtensionAPI, options: CacheDebugOptions = {}): void {
	const sessions = new Map<string, SessionState>();

	const stateFor = (ctx: ExtensionContext): SessionState => {
		const sessionId = ctx.sessionManager.getSessionId();
		const existing = sessions.get(sessionId);
		if (existing !== undefined) return existing;
		const state: SessionState = {
			logPath: resolveLogPath(sessionId, options.logPath),
			previous: undefined,
			requestSequence: 0,
			pendingRequests: [],
			writeFailed: false,
		};
		sessions.set(sessionId, state);
		return state;
	};

	const write = (ctx: ExtensionContext, state: SessionState, record: unknown): void => {
		try {
			mkdirSync(dirname(state.logPath), { recursive: true });
			appendFileSync(state.logPath, `${JSON.stringify(record)}\n`, "utf8");
		} catch (error) {
			if (state.writeFailed) return;
			state.writeFailed = true;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Cache debug logging failed: ${message}`, "error");
		}
	};

	pi.on("session_start", (event, ctx) => {
		const state = stateFor(ctx);
		write(ctx, state, {
			schemaVersion: 1,
			type: "session",
			timestamp: new Date().toISOString(),
			reason: event.reason,
			sessionId: ctx.sessionManager.getSessionId(),
			logPath: state.logPath,
			debugGuide: DEBUG_GUIDE_URL,
		});
	});

	pi.on("before_provider_request", (event, ctx) => {
		const state = stateFor(ctx);
		const snapshot = snapshotProviderPayload(event.payload);
		const comparison = comparePayloadSnapshots(state.previous, snapshot);
		state.requestSequence += 1;
		state.pendingRequests.push(state.requestSequence);
		write(ctx, state, {
			schemaVersion: 1,
			type: "request",
			timestamp: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			request: state.requestSequence,
			model: ctx.model
				? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api }
				: null,
			...requestLogSnapshot(snapshot),
			comparison,
		});
		state.previous = snapshot;
		return undefined;
	});

	pi.on("after_provider_response", (event, ctx) => {
		const state = stateFor(ctx);
		write(ctx, state, {
			schemaVersion: 1,
			type: "http-response",
			timestamp: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			request: state.pendingRequests[0] ?? null,
			status: event.status,
		});
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const state = stateFor(ctx);
		const request = state.pendingRequests.shift() ?? null;
		write(ctx, state, {
			schemaVersion: 1,
			type: "usage",
			timestamp: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			request,
			stopReason: event.message.stopReason,
			hasError: event.message.errorMessage !== undefined,
			usage: {
				input: event.message.usage.input,
				output: event.message.usage.output,
				cacheRead: event.message.usage.cacheRead,
				cacheWrite: event.message.usage.cacheWrite,
			},
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessions.delete(ctx.sessionManager.getSessionId());
	});

	pi.registerCommand("cache-debug", {
		description: "Show the prompt cache diagnostic log and guide",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Log: ${stateFor(ctx).logPath}\nGuide: ${DEBUG_GUIDE_URL}`, "info");
		},
	});
}

function resolveLogPath(sessionId: string, configuredPath?: string): string {
	const safeSessionId = sessionId.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
	const override = configuredPath ?? process.env.PI_CACHE_DEBUG_LOG?.trim();
	if (override) return override.replaceAll("{sessionId}", safeSessionId);
	return join(tmpdir(), "pi", "cache-debug", `${safeSessionId}.jsonl`);
}

export default function piCacheDebugExtension(pi: ExtensionAPI): void {
	registerCacheDebug(pi);
}
