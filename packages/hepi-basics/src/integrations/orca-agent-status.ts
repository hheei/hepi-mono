import { existsSync, readFileSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHepiIntegration } from "./runtime.js";

const POST_TIMEOUT_MS = 1_000;

type Endpoint = {
	readonly port: string;
	readonly token: string;
	readonly environment: string;
	readonly version: string;
};

type PendingPost = {
	readonly name: string;
	readonly extra: Readonly<Record<string, unknown>>;
	readonly session: Readonly<Record<string, string>>;
};

let endpointCacheKey = "";
let endpointCache: Readonly<Record<string, string>> | undefined;
let warnedBadEndpoint = false;

function endpointValues(): Readonly<Record<string, string>> {
	const path = process.env.ORCA_AGENT_HOOK_ENDPOINT;
	if (path === undefined || path.length === 0) return {};
	try {
		const stat = statSync(path);
		const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
		if (key === endpointCacheKey && endpointCache !== undefined) return endpointCache;
		const values: Record<string, string> = {};
		for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
			const match = /^(?:set\s+)?([A-Z0-9_]+)=(.*)$/u.exec(line);
			if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2];
		}
		endpointCacheKey = key;
		endpointCache = values;
		return values;
	} catch (error) {
		endpointCacheKey = "";
		endpointCache = undefined;
		if (!warnedBadEndpoint && (error as NodeJS.ErrnoException).code !== "ENOENT") {
			warnedBadEndpoint = true;
			console.warn(
				`[hepi-orca] Unable to read agent hook endpoint: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return {};
	}
}

function endpoint(): Endpoint | undefined {
	const file = endpointValues();
	const port = file.ORCA_AGENT_HOOK_PORT ?? process.env.ORCA_AGENT_HOOK_PORT;
	const token = file.ORCA_AGENT_HOOK_TOKEN ?? process.env.ORCA_AGENT_HOOK_TOKEN;
	if (port === undefined || token === undefined || port.length === 0 || token.length === 0)
		return undefined;
	return {
		port,
		token,
		environment: file.ORCA_AGENT_HOOK_ENV ?? process.env.ORCA_AGENT_HOOK_ENV ?? "",
		version: file.ORCA_AGENT_HOOK_VERSION ?? process.env.ORCA_AGENT_HOOK_VERSION ?? "",
	};
}

export function orcaAssistantText(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const content = (message as { readonly content?: unknown }).content;
	if (typeof content === "string") return content.length === 0 ? undefined : content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const value = part as { readonly type?: unknown; readonly text?: unknown };
			return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
		})
		.join("");
	return text.length === 0 ? undefined : text;
}

function sessionMetadata(ctx: ExtensionContext): Readonly<Record<string, string>> {
	const id = ctx.sessionManager.getSessionId();
	const file = ctx.sessionManager.getSessionFile();
	if (typeof id !== "string" || id.length === 0) return {};
	if (typeof file === "string" && file.length > 0 && existsSync(file)) {
		return { session_id: id, session_file: file };
	}
	return { session_id: id };
}

export function registerOrcaAgentStatus(pi: ExtensionAPI): void {
	if (process.env.ORCA_PANE_KEY === undefined) return;
	registerHepiIntegration(pi, "orca-agent-status", (isCurrent) => {
		let active = false;
		let pending: PendingPost | undefined;
		let session: Readonly<Record<string, string>> = {};

		const postOnce = async (next: PendingPost): Promise<void> => {
			const coordinates = endpoint();
			const paneKey = process.env.ORCA_PANE_KEY;
			if (coordinates === undefined || paneKey === undefined) return;
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
			timeout.unref?.();
			try {
				await fetch(`http://127.0.0.1:${coordinates.port}/hook/pi`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Orca-Agent-Hook-Token": coordinates.token,
					},
					body: JSON.stringify({
						paneKey,
						launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN ?? "",
						tabId: process.env.ORCA_TAB_ID ?? "",
						worktreeId: process.env.ORCA_WORKTREE_ID ?? "",
						env: coordinates.environment,
						version: coordinates.version,
						payload: { hook_event_name: next.name, ...next.session, ...next.extra },
					}),
					signal: controller.signal,
				});
			} catch {
				// Orca status is best-effort and must not affect Pi's event loop.
			} finally {
				clearTimeout(timeout);
			}
		};
		const drain = (): void => {
			if (active) return;
			const next = pending;
			if (next === undefined) return;
			pending = undefined;
			active = true;
			void postOnce(next).finally(() => {
				active = false;
				if (isCurrent()) drain();
			});
		};
		const post = (name: string, extra: Readonly<Record<string, unknown>> = {}): void => {
			if (!isCurrent()) return;
			pending = { name, extra, session };
			drain();
		};
		const updateSession = (ctx: ExtensionContext): void => {
			session = sessionMetadata(ctx);
		};

		pi.on("session_start", (event, ctx) => {
			if (!isCurrent()) return;
			updateSession(ctx);
			if (event.reason !== "reload") post("session_start");
		});
		pi.on("before_agent_start", (event, ctx) => {
			updateSession(ctx);
			post("before_agent_start", { prompt: event.prompt });
		});
		pi.on("agent_start", (_event, ctx) => {
			updateSession(ctx);
			post("agent_start");
		});
		pi.on("tool_execution_start", (event, ctx) => {
			updateSession(ctx);
			post("tool_execution_start", { tool_name: event.toolName, tool_input: event.args });
		});
		pi.on("tool_call", (event, ctx) => {
			updateSession(ctx);
			post("tool_call", { tool_name: event.toolName, tool_input: event.input });
		});
		pi.on("tool_execution_end", (event, ctx) => {
			updateSession(ctx);
			post("tool_execution_end", { tool_name: event.toolName });
		});
		pi.on("message_end", (event, ctx) => {
			if (event.message.role !== "assistant") return;
			updateSession(ctx);
			const text = orcaAssistantText(event.message);
			if (text !== undefined) post("message_end", { role: "assistant", text });
		});
		pi.on("agent_settled", (_event, ctx) => {
			updateSession(ctx);
			post("agent_end");
		});
		return () => {
			pending = undefined;
		};
	});
}
