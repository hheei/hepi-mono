import { randomUUID } from "node:crypto";
import { basename, resolve as resolvePath } from "node:path";
import type { AgentMemoryConfig } from "#core/config/schema/magic-context";
import { log } from "#core/shared/logger";
import { AgentMemoryClient, type AgentMemoryClientPort, type ObserveResult } from "./client";

const PREFIX = "[magic-context][agentmemory]";
const MAX_CAPTURE_TEXT = 8_000;
const EXCLUDED_TOOLS: Record<string, true> = {
	mctx_memory: true,
	memory_search: true,
};

export type AgentMemoryHostContext = {
	cwd: string;
	sessionManager?: { getSessionId?: () => string | undefined } | undefined;
};

export type AgentMemoryIdentity = {
	project: string;
	agentId?: string | undefined;
};

export type AgentMemoryRuntime = {
	readonly settings: AgentMemoryConfig;
	readonly client: AgentMemoryClientPort;
	identity(cwd: string): AgentMemoryIdentity;
	ensureStarted(ctx: AgentMemoryHostContext): void;
	observe(ctx: AgentMemoryHostContext, hookType: string, data: Record<string, unknown>): void;
	remoteSessionId(piSessionId: string): string | undefined;
	shutdown(): Promise<void>;
};

export type AgentMemorySettingsEnvironment = {
	AGENTMEMORY_URL?: string | undefined;
	AGENTMEMORY_SECRET?: string | undefined;
	AGENTMEMORY_PROJECT_NAME?: string | undefined;
	AGENT_ID?: string | undefined;
};

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function truncate(value: string): string {
	return value.length > MAX_CAPTURE_TEXT ? `${value.slice(0, MAX_CAPTURE_TEXT)}…` : value;
}
function redact(value: string, secrets: readonly string[]): string {
	let next = value;
	for (const secret of secrets) {
		if (secret.length === 0) continue;
		next = next.split(secret).join("[redacted]");
	}
	return truncate(next);
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
	if (typeof value === "string") return redact(value, secrets);
	if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
	if (value !== null && typeof value === "object") {
		const next: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			next[key] = redactValue(entry, secrets);
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

export function overlayAgentMemoryEnv(
	settings: AgentMemoryConfig,
	environment: AgentMemorySettingsEnvironment = process.env,
): AgentMemoryConfig {
	return {
		...settings,
		url: nonEmpty(environment.AGENTMEMORY_URL) ?? settings.url,
		secret: nonEmpty(environment.AGENTMEMORY_SECRET) ?? settings.secret,
		project: nonEmpty(environment.AGENTMEMORY_PROJECT_NAME) ?? settings.project,
		agentId: nonEmpty(environment.AGENT_ID) ?? settings.agentId,
	};
}

export function resolveAgentMemoryProject(cwd: string, explicit: string): string {
	const configured = nonEmpty(explicit);
	if (configured) return configured;
	return basename(resolvePath(cwd)) || cwd;
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
): AgentMemoryRuntime {
	const activationId = `pi-${randomUUID()}`;
	const bindings = new Map<
		string,
		{ remoteSessionId: string; project: string; agentId?: string; cwd: string; ended: boolean }
	>();
	const starting = new Map<string, Promise<string | undefined>>();
	let shuttingDown = false;

	const identity = (cwd: string): AgentMemoryIdentity => {
		const agentId = nonEmpty(settings.agentId);
		return {
			project: resolveAgentMemoryProject(cwd, settings.project),
			...(agentId ? { agentId } : {}),
		};
	};

	const hostSessionId = (ctx: AgentMemoryHostContext): string => {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === "string" && id.length > 0 ? id : `cwd:${ctx.cwd}`;
	};

	const start = async (ctx: AgentMemoryHostContext): Promise<string | undefined> => {
		if (shuttingDown || !settings.enabled || !settings.capture) return undefined;
		const piSessionId = hostSessionId(ctx);
		const existing = bindings.get(piSessionId);
		if (existing && !existing.ended) return existing.remoteSessionId;
		const inFlight = starting.get(piSessionId);
		if (inFlight) return inFlight;
		const pending = (async () => {
			try {
				const resolved = identity(ctx.cwd);
				await client.health();
				const remoteSessionId = `${activationId}:${randomUUID()}`;
				const started = await client.startSession({
					sessionId: remoteSessionId,
					project: resolved.project,
					cwd: ctx.cwd,
					...(resolved.agentId ? { agentId: resolved.agentId } : {}),
				});
				bindings.set(piSessionId, {
					remoteSessionId: started.sessionId,
					project: resolved.project,
					cwd: ctx.cwd,
					ended: false,
					...(resolved.agentId ? { agentId: resolved.agentId } : {}),
				});
				return started.sessionId;
			} catch (error) {
				log(`${PREFIX} session/start failed`, error);
				return undefined;
			}
		})();
		starting.set(piSessionId, pending);
		try {
			return await pending;
		} finally {
			if (starting.get(piSessionId) === pending) starting.delete(piSessionId);
		}
	};

	const observe = (
		ctx: AgentMemoryHostContext,
		hookType: string,
		data: Record<string, unknown>,
	): void => {
		if (!settings.enabled || !settings.capture || shuttingDown) return;
		void (async () => {
			try {
				const remoteSessionId = await start(ctx);
				if (!remoteSessionId) return;
				const binding = bindings.get(hostSessionId(ctx));
				if (!binding || binding.ended) return;
				const secrets = settings.secret ? [settings.secret] : [];
				await client.observe({
					sessionId: remoteSessionId,
					project: binding.project,
					cwd: ctx.cwd,
					hookType,
					data: redactValue(data, secrets) as Record<string, unknown>,
				});
			} catch (error) {
				log(`${PREFIX} observe ${hookType} failed`, error);
			}
		})();
	};

	return {
		settings,
		client,
		identity,
		ensureStarted(ctx) {
			void start(ctx);
		},
		observe,
		remoteSessionId(piSessionId) {
			const binding = bindings.get(piSessionId);
			return binding && !binding.ended ? binding.remoteSessionId : undefined;
		},
		async shutdown() {
			shuttingDown = true;
			await Promise.allSettled(starting.values());
			await Promise.allSettled(
				[...bindings.values()]
					.filter((binding) => !binding.ended)
					.map(async (binding) => {
						binding.ended = true;
						try {
							await client.endSession(binding.remoteSessionId);
						} catch (error) {
							log(`${PREFIX} session/end failed`, error);
						}
					}),
			);
		},
	};
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
	if (isExcludedMemoryTool(event.toolName)) return;
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
	runtime.observe(ctx, "assistant_end", { assistant_output: output });
}

export type { ObserveResult };
