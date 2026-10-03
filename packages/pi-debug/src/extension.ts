import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	errorMessage,
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
} from "@hheei/pi-ext-core";
import {
	comparePayloadSnapshots,
	type PayloadSnapshot,
	requestLogSnapshot,
	snapshotProviderPayload,
} from "./probe.js";
import { createDebugSettingsProvider } from "./settings.js";

interface StreamTelemetry {
	chunkCount: number;
	firstChunkLatencyMs: number;
	startTimeMs: number;
	lastChunkTimeMs: number;
}

interface SessionState {
	readonly logPath: string;
	previous: PayloadSnapshot | undefined;
	requestSequence: number;
	readonly pendingRequests: number[];
	readonly requestStartTimes: Map<number, number>;
	readonly streamTelemetries: Map<number, StreamTelemetry>;
	writeFailed: boolean;
}

export const DEBUG_GUIDE_URL =
	"https://github.com/hheei/hepi-mono/blob/main/packages/pi-debug/CACHE_DEBUG.md";

export interface CacheDebugOptions {
	readonly logPath?: string;
	readonly isEnabled?: (context: ExtensionContext) => boolean;
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
			requestStartTimes: new Map(),
			streamTelemetries: new Map(),
			writeFailed: false,
		};
		sessions.set(sessionId, state);
		return state;
	};
	const enabled = (ctx: ExtensionContext): boolean => options.isEnabled?.(ctx) ?? true;

	const write = (ctx: ExtensionContext, state: SessionState, record: unknown): void => {
		try {
			mkdirSync(dirname(state.logPath), { recursive: true });
			appendFileSync(state.logPath, `${JSON.stringify(record)}\n`, "utf8");
		} catch (error) {
			if (state.writeFailed) return;
			state.writeFailed = true;
			const message = errorMessage(error);
			ctx.ui.notify(`Cache debug logging failed: ${message}`, "error");
		}
	};

	pi.on("session_start", (event, ctx) => {
		if (!enabled(ctx)) return;
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
		if (!enabled(ctx)) return undefined;
		const state = stateFor(ctx);
		const snapshot = snapshotProviderPayload(event.payload);
		const comparison = comparePayloadSnapshots(state.previous, snapshot);
		state.requestSequence += 1;
		state.pendingRequests.push(state.requestSequence);
		state.requestStartTimes.set(state.requestSequence, performance.now());
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
		if (!enabled(ctx)) return;
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

	pi.on("provider_stream_event", (_event, ctx) => {
		if (!enabled(ctx)) return;
		const state = stateFor(ctx);
		const currentRequestId = state.pendingRequests[0];
		if (currentRequestId === undefined) return;
		const now = performance.now();
		const telemetry = state.streamTelemetries.get(currentRequestId);
		if (telemetry === undefined) {
			const requestStart = state.requestStartTimes.get(currentRequestId) ?? now;
			state.streamTelemetries.set(currentRequestId, {
				chunkCount: 1,
				firstChunkLatencyMs: Math.round(now - requestStart),
				startTimeMs: requestStart,
				lastChunkTimeMs: now,
			});
		} else {
			telemetry.chunkCount += 1;
			telemetry.lastChunkTimeMs = now;
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (!enabled(ctx)) return;
		const state = stateFor(ctx);
		const request = state.pendingRequests.shift() ?? null;
		const telemetry = request !== null ? state.streamTelemetries.get(request) : undefined;
		if (request !== null) {
			state.streamTelemetries.delete(request);
			state.requestStartTimes.delete(request);
		}
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
			...(telemetry !== undefined
				? {
						stream: {
							chunkCount: telemetry.chunkCount,
							firstChunkLatencyMs: telemetry.firstChunkLatencyMs,
							durationMs: Math.round(telemetry.lastChunkTimeMs - telemetry.startTimeMs),
						},
					}
				: {}),
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessions.delete(ctx.sessionManager.getSessionId());
	});

	pi.registerCommand("cache-debug", {
		description: "Show the prompt cache diagnostic log and guide",
		handler: async (_args, ctx) => {
			if (!enabled(ctx)) {
				ctx.ui.notify("Cache diagnostics are disabled. Enable Pi Debug in ext-settings.", "info");
				return;
			}
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

export default function piDebugExtension(pi: ExtensionAPI): void {
	const enabledSessions = new Set<string>();
	registerExtensionLifecycle(pi, {
		key: "pi-debug",
		start: async (runtime) => {
			const provider = createDebugSettingsProvider((sessionId, enabled) => {
				if (enabled) enabledSessions.add(sessionId);
				else enabledSessions.delete(sessionId);
			});
			const disposeSettings = registerSettings(provider, getRuntimeSettingsRegistry(pi));
			try {
				const context = {
					sessionId: runtime.extension.sessionManager.getSessionId(),
					cwd: runtime.extension.cwd,
				};
				const state = await provider.storage.load(context);
				await provider.onLoad?.(state ?? {}, context);
			} catch (error) {
				runtime.extension.ui.notify(
					`Unable to load Pi Debug settings: ${errorMessage(error)}`,
					"error",
				);
			}
			runtime.resources.add("pi-debug-settings", () => {
				enabledSessions.delete(runtime.extension.sessionManager.getSessionId());
				disposeSettings();
			});
		},
	});
	registerCacheDebug(pi, {
		isEnabled: (context) => enabledSessions.has(context.sessionManager.getSessionId()),
	});
}
