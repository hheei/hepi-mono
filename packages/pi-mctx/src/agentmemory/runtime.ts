import type { AgentMemoryConfig } from "#core/config/schema/magic-context";
import { log } from "#core/shared/logger";
import type { Database } from "#core/shared/sqlite";
import { SYNTH_USER_ID_PREFIX } from "../read-session-pi";
import { AgentMemoryClient, type AgentMemoryClientPort, type ObserveResult } from "./client";
import { AgentMemoryOutbox } from "./outbox";
import { type AgentMemoryIdentity, createAgentMemoryIdentityResolver } from "./project";
import { AgentMemorySessionManager, resolvePiSessionId } from "./session";
import { SqliteTurnTaintStore, type TurnTaintStore } from "./taint";

export type { AgentMemoryIdentity } from "./project";

const PREFIX = "[magic-context][agentmemory]";
const MAX_CAPTURE_TEXT = 8_000;
const EXCLUDED_TOOLS: Record<string, true> = {
	ctx_memory: true,
	ctx_search: true,
	mctx_memory: true,
	mctx_search: true,
	memory_recall: true,
	memory_save: true,
	memory_search: true,
	memory_smart_search: true,
};

export type AgentMemoryHostContext = {
	cwd: string;
	sessionManager?:
		| {
				getSessionId?: () => string | undefined;
				getSessionFile?: () => string | undefined;
				getBranch?: () => readonly unknown[];
		  }
		| undefined;
};

export type AgentMemoryRuntime = {
	readonly settings: AgentMemoryConfig;
	readonly client: AgentMemoryClientPort;
	readonly sessions: AgentMemorySessionManager;
	readonly taint: TurnTaintStore | undefined;
	readonly outbox: AgentMemoryOutbox | undefined;
	identity(cwd: string): AgentMemoryIdentity;
	ensureStarted(ctx: AgentMemoryHostContext): void;
	observe(ctx: AgentMemoryHostContext, hookType: string, data: Record<string, unknown>): void;
	markCurrentTurnTainted(
		ctx: AgentMemoryHostContext,
		reason: string,
		hostEntryIds?: readonly string[],
	): void;
	propagateCurrentTurnTaint(ctx: AgentMemoryHostContext, hostEntryIds: readonly string[]): void;
	remoteSessionId(piSessionId: string): string | undefined;
	queueMemory(input: {
		readonly cwd: string;
		readonly content: string;
		readonly type?: string | undefined;
	}): Promise<{ status: "queued" | "delivered" | "failed"; id: string }>;
	shutdown(): Promise<void>;
};

export type AgentMemorySettingsEnvironment = {
	AGENTMEMORY_URL?: string | undefined;
	AGENTMEMORY_SECRET?: string | undefined;
	AGENT_ID?: string | undefined;
	AGENTMEMORY_REQUIRE_HTTPS?: string | undefined;
};

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function truncate(value: string): string {
	return value.length > MAX_CAPTURE_TEXT ? `${value.slice(0, MAX_CAPTURE_TEXT)}…` : value;
}

/** Remove configured secrets and common credential shapes before capture. */
export function redactCaptureText(value: string, secrets: readonly string[] = []): string {
	let result = value;
	for (const secret of secrets) {
		if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
	}
	result = result.replace(
		/(\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
		"$1[REDACTED]",
	);
	result = result.replace(
		/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|password|passwd|secret|credential)\s*[=:]\s*)([^\s,;]+)/gi,
		"$1[REDACTED]",
	);
	result = result.replace(/\b(?:sk|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
	return truncate(result);
}

function isCredentialKey(key: string): boolean {
	return /authorization|password|passwd|secret|token|api[_-]?key|credential/i.test(key);
}

/** Recursively sanitize JSON-shaped observation payloads. */
export function redactCaptureValue(value: unknown, secrets: readonly string[] = []): unknown {
	if (typeof value === "string") return redactCaptureText(value, secrets);
	if (Array.isArray(value)) return value.map((entry) => redactCaptureValue(entry, secrets));
	if (value !== null && typeof value === "object") {
		const next: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			next[key] = isCredentialKey(key) ? "[REDACTED]" : redactCaptureValue(entry, secrets);
		}
		return next;
	}
	return value;
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((part) => {
				if (typeof part === "string") return part;
				if (part !== null && typeof part === "object" && "text" in part) {
					const text = (part as { text?: unknown }).text;
					return typeof text === "string" ? text : "";
				}
				return "";
			})
			.join("");
	}
	if (value !== null && typeof value === "object" && "text" in value) {
		const text = (value as { text?: unknown }).text;
		return typeof text === "string" ? text : JSON.stringify(value);
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function assistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === null || typeof message !== "object") continue;
		const role = (message as { role?: unknown }).role;
		if (role !== "assistant") continue;
		return contentText((message as { content?: unknown }).content);
	}
	return "";
}

type BranchMessageEntry = { id: string; message: Record<string, unknown> };

function branchMessageEntries(ctx: AgentMemoryHostContext): BranchMessageEntry[] {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	const entries: BranchMessageEntry[] = [];
	for (const value of branch) {
		if (value === null || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		if (entry.type !== "message" || typeof entry.id !== "string") continue;
		if (entry.message === null || typeof entry.message !== "object") continue;
		entries.push({ id: entry.id, message: entry.message as Record<string, unknown> });
	}
	return entries;
}

function latestEntryId(ctx: AgentMemoryHostContext, role: string): string | undefined {
	const entries = branchMessageEntries(ctx);
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.message.role === role && entry.id.trim()) return entry.id;
	}
	return undefined;
}

function toolResultEntryId(
	ctx: AgentMemoryHostContext,
	toolCallId: string | undefined,
): string | undefined {
	if (!toolCallId) return undefined;
	for (const entry of branchMessageEntries(ctx)) {
		if (entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId) {
			return entry.id;
		}
	}
	return undefined;
}

export function overlayAgentMemoryEnv(
	settings: AgentMemoryConfig,
	environment: AgentMemorySettingsEnvironment = process.env,
): AgentMemoryConfig {
	return {
		...settings,
		url: nonEmpty(environment.AGENTMEMORY_URL) ?? settings.url,
		secret: nonEmpty(environment.AGENTMEMORY_SECRET) ?? settings.secret,
		agentId: nonEmpty(environment.AGENT_ID) ?? settings.agentId,
		requireHttps: environment.AGENTMEMORY_REQUIRE_HTTPS === "1" ? true : settings.requireHttps,
	};
}

export function isExcludedMemoryTool(toolName: string | undefined): boolean {
	return toolName !== undefined && EXCLUDED_TOOLS[toolName.trim().toLowerCase()] === true;
}

export function createAgentMemoryRuntime(
	settings: AgentMemoryConfig,
	client: AgentMemoryClientPort = new AgentMemoryClient({
		url: settings.url,
		secret: settings.secret,
		requireHttps: settings.requireHttps,
	}),
	options: { db?: Database | undefined } = {},
): AgentMemoryRuntime {
	const identity = createAgentMemoryIdentityResolver(settings);
	const sessions = new AgentMemorySessionManager({
		client,
		resolveIdentity: identity,
		enabled: () => settings.enabled && settings.capture,
		onFailure: (operation, error) => log(`${PREFIX} ${operation} failed`, error),
	});
	const taint = options.db ? new SqliteTurnTaintStore(options.db) : undefined;
	const outbox = options.db ? new AgentMemoryOutbox(options.db, client) : undefined;
	const taintedTurnBySession = new Map<string, string>();

	const runtime: AgentMemoryRuntime = {
		settings,
		client,
		sessions,
		taint,
		outbox,
		identity,
		ensureStarted(ctx) {
			void sessions.startForContext(ctx);
		},
		observe(ctx, hookType, data) {
			if (hookType === "prompt_submit") {
				const sessionId = resolvePiSessionId(ctx);
				const currentTurnId = latestEntryId(ctx, "user");
				if (taintedTurnBySession.get(sessionId) !== currentTurnId) {
					taintedTurnBySession.delete(sessionId);
				}
			}
			const secrets = settings.secret ? [settings.secret] : [];
			void sessions.observeForContext(ctx, {
				hookType,
				cwd: ctx.cwd,
				data: redactCaptureValue(data, secrets) as Record<string, unknown>,
			});
		},
		markCurrentTurnTainted(ctx, reason, hostEntryIds = []) {
			const sessionId = resolvePiSessionId(ctx);
			const turnId = latestEntryId(ctx, "user");
			if (!turnId) return;
			taintedTurnBySession.set(sessionId, turnId);
			taint?.mark({ sessionId, turnId, reason, hostEntryIds: [turnId, ...hostEntryIds] });
		},
		propagateCurrentTurnTaint(ctx, hostEntryIds) {
			const sessionId = resolvePiSessionId(ctx);
			const turnId = taintedTurnBySession.get(sessionId);
			if (!turnId) return;
			taint?.mark({ sessionId, turnId, reason: "retrieval-derived", hostEntryIds });
		},
		remoteSessionId(piSessionId) {
			return sessions.getBinding(piSessionId)?.remoteSessionId;
		},
		async queueMemory(input) {
			if (!outbox) throw new Error("AgentMemory outbox is unavailable");
			const resolved = identity(input.cwd);
			return outbox.enqueueAndDrain({
				content: input.content,
				project: resolved.project,
				...(resolved.agentId ? { agentId: resolved.agentId } : {}),
				...(input.type ? { type: input.type } : {}),
			});
		},
		async shutdown() {
			taintedTurnBySession.clear();
			if (outbox) await outbox.drain();
			await sessions.shutdown();
		},
	};
	return runtime;
}

export function capturePrompt(
	runtime: AgentMemoryRuntime,
	ctx: AgentMemoryHostContext,
	prompt: unknown,
): void {
	if (typeof prompt !== "string" || prompt.trim().length === 0) return;
	runtime.observe(ctx, "prompt_submit", { prompt: prompt.trim() });
}

export function captureToolResult(
	runtime: AgentMemoryRuntime,
	ctx: AgentMemoryHostContext,
	event: {
		toolName: string;
		toolCallId?: string | undefined;
		input?: unknown;
		content?: unknown;
		isError?: boolean | undefined;
	},
): void {
	if (isExcludedMemoryTool(event.toolName)) {
		const entryId = toolResultEntryId(ctx, event.toolCallId);
		const hostEntryIds = entryId ? [entryId, `${SYNTH_USER_ID_PREFIX}${entryId}`] : [];
		runtime.markCurrentTurnTainted(ctx, `memory-tool:${event.toolName}`, hostEntryIds);
		return;
	}
	runtime.observe(ctx, event.isError === true ? "post_tool_failure" : "post_tool_use", {
		tool_name: event.toolName,
		...(event.toolCallId ? { tool_call_id: event.toolCallId } : {}),
		tool_input: event.input,
		tool_output: contentText(event.content),
		...(event.isError === true ? { tool_error: true } : {}),
	});
}

export function captureAssistantEnd(
	runtime: AgentMemoryRuntime,
	ctx: AgentMemoryHostContext,
	messages: readonly unknown[] | undefined,
): void {
	if (!Array.isArray(messages)) return;
	const output = assistantText(messages);
	if (output.length === 0) return;
	const assistantEntryId = latestEntryId(ctx, "assistant");
	if (assistantEntryId) runtime.propagateCurrentTurnTaint(ctx, [assistantEntryId]);
	runtime.observe(ctx, "assistant_end", { assistant_output: output });
}

export type { ObserveResult };
