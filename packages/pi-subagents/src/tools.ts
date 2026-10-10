import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { textToolResult } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { DiscoveredAgent } from "./agent-resolver.js";
import { type ChildIdentity, isOperationError, type PublicSubagent } from "./domain.js";

import type { SubagentManager } from "./manager.js";
import { type AgentSpawnDetails, parentToolRenderers } from "./tool-presentation.js";

const spawnSchema = Type.Object(
	{
		task: Type.String({ minLength: 1 }),
		agent: Type.String({
			minLength: 1,
			description: "Agent name from <available_agents> in this tool description.",
		}),
		cwd: Type.Optional(Type.String()),
		title: Type.Optional(
			Type.String({
				maxLength: 60,
				description:
					"Short session title for this child, e.g. 'OVITO properties editor'. It becomes the child's Pi session title, prefixed with a robot marker so delegated sessions stay recognizable; omit it — or leave it blank — to derive one from the agent name and child id.",
			}),
		),
	},
	{ additionalProperties: false },
);
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
const getSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Subagent id, e.g. agent-1" }),
	keys: Type.Optional(
		Type.String({
			description:
				"Comma-separated fields to return. Defaults to 'status,progress'. Allowed: status, progress, diagnostic.",
		}),
	),
});
const contactSchema = Type.Object({
	message: Type.String({
		minLength: 1,
		description: "Explanation of what is blocking progress or the error encountered.",
	}),
	reason: Type.Optional(
		Type.Union([Type.Literal("blocked"), Type.Literal("error")], {
			description:
				"Reason: 'blocked' if waiting for input/guidance (can be resumed via agent_send), or 'error' if the turn failed (you may retry via agent_send or create a new child). Defaults to 'blocked'.",
		}),
	),
});

const SUBAGENTS_NAMESPACE = {
	name: "agent",
	description: "Subagent orchestration and delegation tools",
} as const;

export function formatAvailableAgents(agents: readonly DiscoveredAgent[]): string {
	const available = agents
		.filter((agent) => agent.enabled !== false && agent.frontmatter.hidden !== true)
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((agent) => {
			const description = agent.frontmatter.description;
			return `- ${agent.name}: ${typeof description === "string" && description.trim() !== "" ? description.trim() : "No description provided."}`;
		});
	return [
		"<available_agents>",
		...(available.length > 0 ? available : ["None."]),
		"</available_agents>",
	].join("\n");
}

function getSpawnDescription(agents: readonly DiscoveredAgent[]): string {
	return [
		"Spawn an independent background subagent task to work on a goal asynchronously. Choose an agent from <available_agents> below.",
		"Returns JSON { id, path }, where path is the absolute child session file path; the first write may still be pending.",
		"Results are returned automatically to this parent session when the task finishes. After spawning, do independent work or end your turn; do not poll agent_get.",
		"Related subagent tools: agent_send, agent_get, agent_stop.",
		formatAvailableAgents(agents),
	].join("\n");
}
const SEND_DESCRIPTION =
	"Send input, steer, or follow-up instructions to an existing subagent (e.g. 'agent-1'), resuming its session when it is idle, blocked, done, or errored. Results are returned automatically when the task finishes; do not poll agent_get. Related subagent tools: agent_spawn, agent_get, agent_stop.";
const GET_DESCRIPTION =
	"Inspect one subagent's status, progress, or diagnostic details by id (e.g. 'agent-1'). Use keys to choose fields; defaults to 'status,progress'. Results are returned automatically; use this for inspection, not completion polling. Related subagent tools: agent_spawn, agent_send, agent_stop.";
const STOP_DESCRIPTION =
	"Stop a subagent's runtime by id (e.g. 'agent-1'). The child keeps its session, so a later agent_send can resume it. Related subagent tools: agent_spawn, agent_send, agent_get.";
const CONTACT_DESCRIPTION =
	"Notify the parent session when you are BLOCKED and cannot continue without parent decision or intervention. Do NOT call this on success or task completion: simply output your final answer directly as normal text in your response, and the harness will automatically capture and report your result to the parent.";
const CONTACT_SNIPPET =
	"Report a blocker to the parent. Do NOT call on success: write normal text to finish.";
const CONTACT_GUIDELINES = [
	"Use contact_parent ONLY if you are blocked or urgently require a parent decision midway.",
	"Do NOT use contact_parent to deliver final findings or report success: output normal text instead.",
	"After reporting a blocker, wait for a parent agent_send instruction.",
] as const;

const GET_KEYS = ["status", "progress", "diagnostic"] as const;
export type AgentGetKey = (typeof GET_KEYS)[number];

/** Parses the comma-separated `keys` argument; empty means the default view. */
function parseAgentGetKeys(raw: string | undefined): readonly AgentGetKey[] {
	if (raw === undefined) return ["status", "progress"];
	const keys: AgentGetKey[] = [];
	for (const part of raw.split(",")) {
		const key = part.trim();
		if (key === "") continue;
		if (!(GET_KEYS as readonly string[]).includes(key)) {
			throw new Error(`Unknown agent_get key "${key}". Allowed keys: ${GET_KEYS.join(", ")}.`);
		}
		if (!keys.includes(key as AgentGetKey)) keys.push(key as AgentGetKey);
	}
	return keys.length > 0 ? keys : ["status", "progress"];
}

function childAgentDetails(
	child: PublicSubagent,
	keys: readonly AgentGetKey[],
): Record<string, unknown> {
	const view: Record<string, unknown> = {};
	if (keys.includes("status")) view.status = child.state;
	if (keys.includes("progress")) {
		view.progress = {
			agent: child.agent,
			...(child.path === undefined ? {} : { path: child.path }),
			presentation: child.presentation,
			freshness: child.freshness,
			...(child.activeTool === undefined ? {} : { activeTool: child.activeTool.slice(0, 200) }),
			...(child.state !== "running" || child.summary === undefined
				? {}
				: { summary: child.summary.slice(0, 2000) }),
			...(child.usage === undefined
				? {}
				: { turns: child.usage.turns, tokens: child.usage.inputTokens + child.usage.outputTokens }),
		};
	}
	if (keys.includes("diagnostic")) {
		const diagnostic =
			child.interrupted ??
			(child.state === "blocked" || child.state === "error" ? child.summary : undefined) ??
			(child.freshness === "last_known" ? "Runtime disconnected; state is last known" : undefined);
		if (diagnostic !== undefined) view.diagnostic = diagnostic.slice(0, 2000);
	}
	return view;
}

export function registerParentTools(
	pi: ExtensionAPI,
	manager: SubagentManager,
	agents: readonly DiscoveredAgent[],
): void {
	const renderers = parentToolRenderers(pi);
	const inspectedTasks = new Set<string>();
	function inspectionResult<T>(id: string, text: string, details: T): AgentToolResult<T> {
		const repeated = inspectedTasks.has(id);
		inspectedTasks.add(id);
		return textToolResult(
			repeated ? `${text}\nResults are returned automatically; do not poll agent_get.` : text,
			details,
		);
	}
	const spawn: ToolDefinition<typeof spawnSchema> = {
		name: "agent_spawn",
		namespace: SUBAGENTS_NAMESPACE,
		label: "Spawn agent",
		description: getSpawnDescription(agents),
		parameters: spawnSchema,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			openWorldHint: true,
		},
		async execute(_id, params) {
			if (!Value.Check(spawnSchema, params)) throw new Error("Invalid agent_spawn parameters");
			const spawned = await manager.spawn(params);
			if (isOperationError(spawned)) throw new Error(spawned.reason);
			const { id } = spawned.child;
			const { path } = spawned;
			const details: AgentSpawnDetails = { id, path };
			return textToolResult(JSON.stringify(details), details);
		},
		...renderers.spawn,
	};
	const send: ToolDefinition<typeof sendSchema> = {
		name: "agent_send",
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
			const sent = await manager.send(params.id, params.message, params.mode, signal);
			if (isOperationError(sent)) throw new Error(sent.reason);
			return textToolResult("Message sent.", undefined);
		},
		...renderers.send,
	};
	const get: ToolDefinition<typeof getSchema> = {
		name: "agent_get",
		namespace: SUBAGENTS_NAMESPACE,
		label: "Get agent",
		description: GET_DESCRIPTION,
		parameters: getSchema,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		async execute(_id, params) {
			const keys = parseAgentGetKeys(params.keys);
			const child = await manager.get(params.id);
			if (isOperationError(child)) throw new Error(child.reason);
			const view = childAgentDetails(child, keys);
			return inspectionResult(params.id, JSON.stringify(view), view);
		},
		...renderers.get,
	};
	const stop: ToolDefinition<typeof idSchema> = {
		name: "agent_stop",
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
			const stopped = await manager.stop(params.id);
			if (isOperationError(stopped)) throw new Error(stopped.reason);
			return textToolResult("Agent stopped.", undefined);
		},
		...renderers.stop,
	};
	pi.registerTool(spawn);
	pi.registerTool(send);
	pi.registerTool(get);
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
				undefined,
			);
		},
	};
	pi.registerTool(tool);
}
