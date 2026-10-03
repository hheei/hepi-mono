import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { getToolTui, isRecord, textToolResult } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { type DiscoveredAgent, discoverAgents } from "./agent-resolver.js";
import { builtinAgents } from "./builtin-agents.js";
import type { SubagentManager } from "./manager.js";

/** Interactive agent tools managed by dynamic activation. */
export const INTERACTIVE_TOOL_NAMES = [
	"spawn_agent",
	"send_agent",
	"get_agent",
	"stop_agent",
] as const;

export type InteractiveToolName = (typeof INTERACTIVE_TOOL_NAMES)[number];

export const SUBAGENT_LOADER_NAME = "subagent_enable";
export const SUBAGENTS_LOADER_NAME = SUBAGENT_LOADER_NAME;

const DESCRIPTION =
	"Enable interactive agent tools (spawn_agent, send_agent, get_agent, stop_agent) for running interactive subagents. Enabled tools are available on the next model request.";

const SNIPPET =
	"Interactive subagents (spawn_agent, send_agent, get_agent, stop_agent) require activation. Call subagent_enable to activate them.";

const emptySchema = Type.Object({}, { additionalProperties: false });

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
					if (part.name === SUBAGENT_LOADER_NAME || names.has(part.name)) return true;
				}
			}
		}
		if (
			msg.role === "tool" &&
			typeof msg.toolName === "string" &&
			(msg.toolName === SUBAGENT_LOADER_NAME || names.has(msg.toolName))
		) {
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
	const tui = getToolTui(pi);

	const loaderTool: ToolDefinition<typeof emptySchema> = {
		name: SUBAGENT_LOADER_NAME,
		label: "Enable Interactive Subagents",
		description: DESCRIPTION,
		promptSnippet: SNIPPET,
		parameters: emptySchema,
		async execute(_id, _params, _signal, _onUpdate, execCtx): Promise<AgentToolResult<unknown>> {
			const registered = new Set(pi.getAllTools().map((tool) => tool.name));
			const unavailable = names.filter((name) => !registered.has(name));
			if (unavailable.length > 0) {
				throw new Error(`Cannot enable unavailable tools: ${unavailable.join(", ")}.`);
			}

			const cwd =
				execCtx !== undefined &&
				typeof execCtx === "object" &&
				"cwd" in execCtx &&
				typeof execCtx.cwd === "string"
					? execCtx.cwd
					: (context.cwd ?? process.cwd());

			let allAgents: readonly DiscoveredAgent[];
			try {
				allAgents = await discoverAgents(cwd);
			} catch {
				allAgents = builtinAgents();
			}

			const interactiveAgents = allAgents
				.filter(
					(agent) => agent.frontmatter.interactive === true && agent.frontmatter.hidden !== true,
				)
				.map((agent) => ({
					name: agent.name,
					description:
						typeof agent.frontmatter.description === "string" &&
						agent.frontmatter.description.trim() !== ""
							? agent.frontmatter.description.trim()
							: "No description provided.",
				}))
				.sort((a, b) => a.name.localeCompare(b.name));

			const currentlyActive = new Set(pi.getActiveTools());
			const alreadyActive = names.every((name) => currentlyActive.has(name));

			if (!alreadyActive) {
				try {
					pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`Activation failed: ${message}.`);
				}
			}

			const lines: string[] = [
				alreadyActive
					? `Interactive agent tools are already enabled: ${names.join(", ")}.`
					: `Enabled interactive agent tools: ${names.join(", ")}. They will be available on the next model request.`,
			];

			if (interactiveAgents.length > 0) {
				lines.push("");
				lines.push("<interactive_agents>");
				for (const agent of interactiveAgents) {
					lines.push(`- ${agent.name}: ${agent.description}`);
				}
				lines.push("</interactive_agents>");
			}

			return textToolResult(lines.join("\n"), {
				enabled: [...names],
				...(interactiveAgents.length > 0 ? { interactiveAgents } : {}),
			});
		},
	};

	pi.registerTool(
		tui.frame(loaderTool, {
			summary: () => "enable interactive subagents",
			headerLine: "truncate",
			footer: (result) => {
				const details = result.details as { readonly enabled?: readonly string[] } | undefined;
				const count = details?.enabled?.length;
				return count !== undefined
					? count === 1
						? "1 tool enabled"
						: `${count} tools enabled`
					: undefined;
			},
		}),
	);

	function loaderAvailable(): boolean {
		return pi.getAllTools().some((tool) => tool.name === SUBAGENT_LOADER_NAME);
	}

	async function selectFromSession(ctx: ExtensionContext): Promise<void> {
		if (!loaderAvailable()) return;
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
			pi.setActiveTools([...new Set([...active, SUBAGENT_LOADER_NAME])]);
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
	const unbindBeforeAgentStart = () => {
		if (!loaderAvailable() || pi.getActiveTools().includes(SUBAGENT_LOADER_NAME)) return;
		try {
			pi.setActiveTools([...pi.getActiveTools(), SUBAGENT_LOADER_NAME]);
		} catch {
			// Best effort
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
