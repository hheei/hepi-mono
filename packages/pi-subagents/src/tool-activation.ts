import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, setPromptSection } from "@hheei/pi-ext-core";
import { discoverAgents } from "./agent-resolver.js";
import type { SubagentManager } from "./manager.js";

/** Interactive agent tools managed by dynamic activation. */
export const INTERACTIVE_TOOL_NAMES = [
	"spawn_agent",
	"send_agent",
	"get_agent",
	"stop_agent",
] as const;

export type InteractiveToolName = (typeof INTERACTIVE_TOOL_NAMES)[number];

export const SUBAGENT_PROMPT_SECTION = "subagent_guidance";

export const SUBAGENT_DEFERRED_PROMPT_GUIDANCE =
	'Subagent tools (spawn_agent, send_agent, get_agent, stop_agent) are deferred. Use tool_search ({ query: "agent" }) to discover and load them when needed.';

export const USAGE_GUIDE = [
	"Reuse an existing subagent via send_agent for related work. Inspect available definitions and owned children with list_agents before creating a new child; use get_agent for current identity or state.",
	"Spawn a new agent only when a distinct role or fresh context is needed. Idle children consume no compute and do not need to be frozen, paused, or stopped before other work starts.",
	"send_agent can resume done, blocked, errored, or stopped children with their session context. After an error, retry send_agent or create a new child with spawn_agent; neither guarantees recovery. A previous runtime must be confirmed stopped before starting a replacement.",
	"Child results arrive automatically as subagent-report messages, including while you work on other tasks. After spawn or send, do independent work or end your turn. Do not poll get_agent or list_agents, sleep, wait, or tail session/log files to detect completion. Do not fabricate or summarize results before a report arrives.",
	"Background job controls may become available when a task starts. Subagent task ids use the same agent-X format returned by spawn_agent, for example agent-1. Do not use wait_jobs to wait for subagent reports: healthy subagents report automatically and close themselves. wait_jobs is optional and only for directly reading a result when needed; stop_jobs is optional and only for explicitly terminating a job that should not continue. Use stop_agent to end a child runtime intentionally.",
].join("\n");

export async function buildSubagentPromptGuidance(cwd: string): Promise<string> {
	const allAgents = await discoverAgents(cwd);
	const availableAgents = allAgents
		.filter((agent) => agent.enabled !== false && agent.frontmatter.hidden !== true)
		.map((agent) => ({
			name: agent.name,
			description:
				typeof agent.frontmatter.description === "string" &&
				agent.frontmatter.description.trim() !== ""
					? agent.frontmatter.description.trim()
					: "No description provided.",
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	const lines = [USAGE_GUIDE];
	if (availableAgents.length > 0) {
		lines.push("", "<available_agents>");
		for (const agent of availableAgents) {
			lines.push(`- ${agent.name}: ${agent.description}`);
		}
		lines.push("</available_agents>");
	}
	return lines.join("\n");
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

const LEGACY_TOOL_NAMES = new Set([
	"spawn_subagent",
	"send_subagent",
	"get_subagent",
	"stop_subagent",
	"list_subagents",
	"subagents_enable",
	"subagent_enable",
]);

function branchHasSubagentCalls(
	messages: readonly unknown[],
	toolNames: readonly string[],
): boolean {
	const names = new Set([...toolNames, ...LEGACY_TOOL_NAMES]);
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
				const guidance = await buildSubagentPromptGuidance(context.cwd ?? process.cwd());
				setPromptSection(sections, SUBAGENT_PROMPT_SECTION, guidance);
			} else {
				setPromptSection(sections, SUBAGENT_PROMPT_SECTION, SUBAGENT_DEFERRED_PROMPT_GUIDANCE);
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
