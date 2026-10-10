import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord, setPromptSection, setSectionBullet } from "@hheei/pi-ext-core";
import { discoverAgents } from "./agent-resolver.js";
import type { SubagentManager } from "./manager.js";
import { formatAvailableAgents } from "./tools.js";

/** Interactive agent tools managed by dynamic activation. */
export const INTERACTIVE_TOOL_NAMES = [
	"agent_spawn",
	"agent_send",
	"agent_get",
	"agent_stop",
] as const;

export type InteractiveToolName = (typeof INTERACTIVE_TOOL_NAMES)[number];

export const SUBAGENT_PROMPT_SECTION = "subagent_guidance";
export const DEFERRED_TOOLS_SECTION = "deferred_tools";

export const SUBAGENT_TOOL_SEARCH_BULLET =
	'Subagent orchestration and delegation tools (agent_spawn, agent_send, agent_get, agent_stop). Use tool_search ({ query: "agent" }) to load.';
export const SUBAGENT_CODEMODE_BULLET =
	"Subagent orchestration and delegation tools (agent_spawn, agent_send, agent_get, agent_stop). Call from codemode scripts via tools.agent_spawn.";

export function buildUsageGuide(): string {
	return [
		`Choose an agent from <available_agents> in the agent_spawn tool description. Custom definitions are markdown files in project (.pi/agents/*.md, .agents/agents/*.md) and user (${join(getAgentDir(), "agents")}/*.md) directories; read a definition when you need its full instructions.`,
		"agent_spawn returns JSON { id, path }, where path is the child session file path. agent_get progress.path provides the same path; the first write may still be pending.",
		"Reuse an existing subagent via agent_send for related work; use agent_get for current identity or state.",
		"Spawn a new agent only when a distinct role or fresh context is needed. Idle children consume no compute and do not need to be frozen, paused, or stopped before other work starts.",
		"agent_send can resume done, blocked, errored, or stopped children with their session context. After an error, retry agent_send or create a new child with agent_spawn; neither guarantees recovery.",
		"Child results arrive automatically as <task-notice> or subagent-report messages, including while you work on other tasks. After spawn or send, do independent work or end your turn. Do not poll agent_get, sleep, or wait to detect completion.",
		"Use agent_stop to end a running subagent's runtime by its id (e.g. agent-1); a later agent_send can resume it.",
	].join("\n");
}

export const USAGE_GUIDE = buildUsageGuide();

export async function buildSubagentPromptGuidance(cwd: string): Promise<string> {
	return [buildUsageGuide(), "", formatAvailableAgents(await discoverAgents(cwd))].join("\n");
}

export function supportsDynamicTools(pi: ExtensionAPI): boolean {
	return (
		typeof pi.getAllTools === "function" &&
		typeof pi.getActiveTools === "function" &&
		typeof pi.setActiveTools === "function"
	);
}

function hasToolDeclarations(messages: readonly unknown[]): boolean {
	return messages.some(
		(message) => isRecord(message) && ("toolsAdded" in message || "toolsRemoved" in message),
	);
}

function currentTranscriptToolNames(messages: readonly unknown[]): string[] {
	const tools = new Set<string>();
	for (const message of messages) {
		if (!isRecord(message)) continue;
		const declaration = message as {
			toolsAdded?: Array<{ name: string }>;
			toolsRemoved?: Array<{ name: string }>;
		};
		for (const tool of declaration.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of declaration.toolsAdded ?? []) tools.add(tool.name);
	}
	return [...tools];
}

function branchHasSubagentCalls(
	messages: readonly unknown[],
	toolNames: readonly string[],
): boolean {
	const names = new Set(toolNames);
	for (const msg of messages) {
		if (!isRecord(msg)) continue;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (
					isRecord(part) &&
					(part.type === "tool_use" || part.type === "toolCall") &&
					typeof part.name === "string"
				) {
					if (names.has(part.name)) return true;
				}
			}
		}
		if (msg.role === "tool" && typeof msg.toolName === "string" && names.has(msg.toolName)) {
			return true;
		}
	}
	return false;
}

export interface RegisterInteractiveToolActivationOptions {
	readonly pi: ExtensionAPI;
	readonly manager: SubagentManager;
	readonly context: ExtensionContext;
}

export interface InteractiveToolActivationHandle {
	dispose(): void;
	selectFromSession(ctx: ExtensionContext): Promise<void>;
}

export function registerInteractiveToolActivation(
	options: RegisterInteractiveToolActivationOptions,
): InteractiveToolActivationHandle {
	const { pi, manager, context } = options;
	if (!supportsDynamicTools(pi)) {
		return {
			dispose() {},
			selectFromSession: async () => {},
		};
	}

	const names: readonly string[] = INTERACTIVE_TOOL_NAMES;

	async function selectFromSession(ctx: ExtensionContext): Promise<void> {
		try {
			let messages: readonly unknown[] = [];
			try {
				const branch = ctx.sessionManager?.getBranch?.();
				if (Array.isArray(branch) && branch.length > 0) {
					messages = buildSessionContext(branch).messages;
				}
			} catch {
				// branch or sessionManager may not be available in mock contexts
			}

			let hasLiveChildren = false;
			try {
				const children = await manager.list();
				hasLiveChildren = children.some(
					(child) => child.freshness === "live" || child.state === "running",
				);
			} catch {
				// manager may be recovering or unavailable
			}

			const recorded = hasToolDeclarations(messages)
				? new Set(currentTranscriptToolNames(messages))
				: messages.length > 0 && branchHasSubagentCalls(messages, names)
					? new Set(names)
					: new Set<string>();

			const shouldBeActive = hasLiveChildren || names.some((name) => recorded.has(name));

			const heavy = new Set<string>(names);
			const active = pi.getActiveTools().filter((name) => !heavy.has(name));
			if (shouldBeActive) {
				for (const name of names) active.push(name);
			}
			pi.setActiveTools([...new Set(active)]);
		} catch (error) {
			console.warn(
				`[pi-subagents] Subagent tool activation setup fallback: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	const unbindSessionStart = pi.on("session_start", (_event, ctx) => {
		void selectFromSession(ctx);
	});
	const unbindSessionTree = pi.on("session_tree", (_event, ctx) => {
		void selectFromSession(ctx);
	});
	const unbindBeforeAgentStart = async (event: {
		systemPromptOptions?: { sections: Record<string, string> };
	}) => {
		const sections = event.systemPromptOptions?.sections;
		if (sections !== undefined) {
			const activeTools = new Set(pi.getActiveTools());
			const isInteractiveActive = names.some((name) => activeTools.has(name));
			if (isInteractiveActive) {
				setSectionBullet(sections, DEFERRED_TOOLS_SECTION, "subagents", undefined);
				const guidance = await buildSubagentPromptGuidance(context.cwd ?? process.cwd());
				setPromptSection(sections, SUBAGENT_PROMPT_SECTION, guidance);
			} else {
				setPromptSection(sections, SUBAGENT_PROMPT_SECTION, undefined);
				if (activeTools.has("tool_search")) {
					setSectionBullet(
						sections,
						DEFERRED_TOOLS_SECTION,
						"subagents",
						SUBAGENT_TOOL_SEARCH_BULLET,
					);
				} else if (activeTools.has("codemode")) {
					setSectionBullet(sections, DEFERRED_TOOLS_SECTION, "subagents", SUBAGENT_CODEMODE_BULLET);
				} else {
					setSectionBullet(sections, DEFERRED_TOOLS_SECTION, "subagents", undefined);
				}
			}
		}
	};
	const unbindBeforeAgent = pi.on("before_agent_start", unbindBeforeAgentStart);

	void selectFromSession(context);

	return {
		dispose() {
			unbindSessionStart();
			unbindSessionTree();
			unbindBeforeAgent();
		},
		selectFromSession,
	};
}
