import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { textToolResult } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { type ChildIdentity, isOperationError, type PublicSubagent } from "./domain.js";

import type { SubagentManager } from "./manager.js";

const spawnSchema = Type.Object({
	id: Type.Optional(
		Type.String({
			description:
				"Optional subagent id (e.g. 'agent-1') to re-awaken an idle or completed subagent with a new task instead of creating a new one.",
		}),
	),
	task: Type.String({ minLength: 1 }),
	agent: Type.String({
		minLength: 1,
		description: "Name of an agent defined in .pi/agents/*.md or ~/.pi/agent/agents/*.md",
	}),
	cwd: Type.Optional(Type.String()),
	title: Type.Optional(
		Type.String({
			maxLength: 60,
			description:
				"Short session title for this child, e.g. 'OVITO properties editor'. It becomes the child's Pi session title, prefixed with a robot marker so delegated sessions stay recognizable; omit it — or leave it blank — to derive one from the agent name and child id.",
		}),
	),
});
const sendSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Subagent id, e.g. agent-1" }),
	message: Type.String({ minLength: 1 }),
	mode: Type.Optional(
		Type.Union([Type.Literal("steer"), Type.Literal("follow_up"), Type.Literal("auto")]),
	),
});
const idSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Subagent id, e.g. agent-1" }),
});
const contactSchema = Type.Object({
	message: Type.String({
		minLength: 1,
		description: "Explanation of what is blocking progress or the error encountered.",
	}),
	reason: Type.Optional(
		Type.Union([Type.Literal("blocked"), Type.Literal("error")], {
			description:
				"Reason: 'blocked' if waiting for input/guidance (can be resumed via send_agent), or 'error' if the turn failed (you may retry via send_agent or create a new child). Defaults to 'blocked'.",
		}),
	),
});
const emptySchema = Type.Object({});

function result(value: unknown): AgentToolResult<unknown> {
	if (isOperationError(value)) throw new Error(JSON.stringify(value));
	return textToolResult(typeof value === "string" ? value : JSON.stringify(value), value);
}

const SUBAGENTS_NAMESPACE = {
	name: "subagents",
	description: "Subagent orchestration and delegation tools",
} as const;

const SPAWN_DESCRIPTION = "Start an independent background RPC agent with a new task.";
const SEND_DESCRIPTION =
	"Send a steer or follow-up message to one owned child, resuming its session when needed.";
const GET_DESCRIPTION =
	"Inspect one owned child: state, presentation, summary, usage, and whether the view is live or last-known.";
const LIST_DESCRIPTION =
	"List available interactive agent definitions and this parent session's running or past children with their state.";
const STOP_DESCRIPTION = "Persist a stopped intent, then end that child's runtime.";
const CONTACT_DESCRIPTION =
	"Notify the parent session when you are BLOCKED and cannot continue without parent decision or intervention. Do NOT call this on success or task completion: simply output your final answer directly as normal text in your response, and the harness will automatically capture and report your result to the parent.";
const CONTACT_SNIPPET =
	"Report a blocker to the parent. Do NOT call on success: write normal text to finish.";
const CONTACT_GUIDELINES = [
	"Use contact_parent ONLY if you are blocked or urgently require a parent decision midway.",
	"Do NOT use contact_parent to deliver final findings or report success: output normal text instead.",
	"After reporting a blocker, wait for a parent send_agent instruction.",
] as const;

export function formatChildAgentText(child: PublicSubagent): string {
	const lines: string[] = [];
	const agentLabel = child.displayName ? `${child.displayName} (${child.agent})` : child.agent;
	lines.push(`Agent ${child.id} [${agentLabel}]:`);
	lines.push(`- State: ${child.state}`);
	if (child.task) {
		lines.push(`- Task: ${child.task}`);
	}
	if (child.activeTool) {
		lines.push(`- Active tool: ${child.activeTool}`);
	}
	if (child.interrupted) {
		lines.push(`- Interrupted: ${child.interrupted}`);
	}
	if (child.summary) {
		lines.push(`- Recent output: ${child.summary}`);
	}
	if (child.usage) {
		const parts: string[] = [];
		if (child.usage.turns > 0) parts.push(`${child.usage.turns} turn(s)`);
		const tokens = child.usage.inputTokens + child.usage.outputTokens;
		if (tokens > 0) {
			parts.push(
				`${tokens} tokens (${child.usage.inputTokens} in / ${child.usage.outputTokens} out)`,
			);
		}
		if (parts.length > 0) lines.push(`- Usage: ${parts.join(", ")}`);
	}
	lines.push(`- Freshness: ${child.freshness}`);
	return lines.join("\n");
}

export function registerParentTools(pi: ExtensionAPI, manager: SubagentManager): void {
	const spawn: ToolDefinition<typeof spawnSchema> = {
		name: "spawn_agent",
		namespace: SUBAGENTS_NAMESPACE,
		label: "Spawn agent",
		description: SPAWN_DESCRIPTION,
		parameters: spawnSchema,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			openWorldHint: true,
		},
		async execute(_id, params) {
			return result(await manager.spawn(params));
		},
	};
	const send: ToolDefinition<typeof sendSchema> = {
		name: "send_agent",
		namespace: SUBAGENTS_NAMESPACE,
		label: "Send to agent",
		description: SEND_DESCRIPTION,
		parameters: sendSchema,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			openWorldHint: true,
		},
		async execute(_id, params, signal) {
			return result(await manager.send(params.id, params.message, params.mode, signal));
		},
	};
	const get: ToolDefinition<typeof idSchema> = {
		name: "get_agent",
		namespace: SUBAGENTS_NAMESPACE,
		label: "Get agent",
		description: GET_DESCRIPTION,
		parameters: idSchema,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		async execute(_id, params) {
			const child = await manager.get(params.id);
			if (isOperationError(child)) throw new Error(JSON.stringify(child));
			return textToolResult(formatChildAgentText(child), child);
		},
	};
	const list: ToolDefinition<typeof emptySchema> = {
		name: "list_agents",
		namespace: SUBAGENTS_NAMESPACE,
		label: "List agents",
		description: LIST_DESCRIPTION,
		parameters: emptySchema,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			const children = await manager.list();
			const lines: string[] = [];
			if (children.length > 0) {
				lines.push("<owned_child_agents>");
				for (const child of children) {
					const summaryPart = child.summary ? ` | summary: ${child.summary}` : "";
					lines.push(
						`- id: ${child.id} | agent: ${child.agent} | state: ${child.state}${summaryPart}`,
					);
				}
				lines.push("</owned_child_agents>");
			}

			if (lines.length === 0) {
				lines.push("No child agents are currently owned by this parent session.");
			}

			return textToolResult(lines.join("\n"), {
				runningAgents: children,
			});
		},
	};
	const stop: ToolDefinition<typeof idSchema> = {
		name: "stop_agent",
		namespace: SUBAGENTS_NAMESPACE,
		label: "Stop agent",
		description: STOP_DESCRIPTION,
		parameters: idSchema,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			destructiveHint: true,
		},
		async execute(_id, params) {
			return result(await manager.stop(params.id));
		},
	};
	pi.registerTool(spawn);
	pi.registerTool(send);
	pi.registerTool(get);
	pi.registerTool(list);
	pi.registerTool(stop);
}

/** Sends a child-initiated request over the bridge and resolves with the parent's answer. */
export type ChildReport = (
	operation: string,
	payload: unknown,
	signal?: AbortSignal,
) => Promise<unknown>;

export interface RegisterChildToolsOptions {
	/** The bridge connection to the parent; a child without one cannot report anything. */
	readonly report: ChildReport;
	readonly isBound?: (sessionId: string) => boolean;
}

export function registerChildTools(
	pi: ExtensionAPI,
	identity: ChildIdentity,
	options: RegisterChildToolsOptions,
): void {
	const tool: ToolDefinition<typeof contactSchema> = {
		name: "contact_parent",
		label: "Contact parent",
		description: CONTACT_DESCRIPTION,
		promptSnippet: CONTACT_SNIPPET,
		promptGuidelines: [...CONTACT_GUIDELINES],
		parameters: contactSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (options.isBound !== undefined && !options.isBound(sessionId)) {
				throw new Error(
					"This Pi session is not the bound subagent session; contact_parent is disabled.",
				);
			}
			const reason = params.reason ?? "blocked";
			const details = {
				type: "pi_subagent_report" as const,
				parentSessionId: identity.parentSessionId,
				childId: identity.subagentId,
				runtimeIdentity: identity.runtimeIdentity,
				reason,
				message: params.message,
				sessionId,
			};
			await options.report("contact_parent", details, signal);
			return textToolResult(
				reason === "error"
					? "Error report delivered to the parent."
					: "Blocker report queued for the parent.",
				details,
			);
		},
	};
	pi.registerTool(tool);
}
