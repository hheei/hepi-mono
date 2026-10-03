import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getToolTui, isRecord, registerToolTuiTrace, textToolResult } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { type DiscoveredAgent, discoverAgents } from "./agent-resolver.js";
import { builtinAgents } from "./builtin-agents.js";
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
	forkFrom: Type.Optional(
		Type.String({
			description:
				"Optional session or subagent id to reference context from: 'parent' (parent session), or a subagent id like 'agent-1'. Does not inject past conversation into the prompt; provides the referenced session JSONL path in instructions so the subagent can inspect prior context on demand via read or grep. Cannot be 'current'.",
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
		description:
			"Explanation of why you are blocked and what decision or intervention is required from the parent.",
	}),
	reason: Type.Optional(
		Type.Literal("blocked", {
			description:
				"Optional blocker indicator (defaults to 'blocked'). Do NOT call on success: write normal text to finish.",
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

const SPAWN_DESCRIPTION =
	"Start an independent background RPC agent. This call waits until the child runtime is ready, then returns the child id and initial state. Do NOT freeze, pause, or stop other sub-workers before spawning: idle subagents do not consume compute or interfere, so do not waste an agent turn freezing them. Do NOT poll get_agent or list_agents to wait for the child's work. Results are automatically captured when the child settles, and delivered as a pi-subagent-report message to start your next turn; while you are idle, reports from several children may arrive together. After this tool returns, either end your turn or work on other independent tasks, including spawning more agents in parallel. Do not fabricate or assume the child's results.";
const SPAWN_SNIPPET =
	"Start a background RPC agent. No need to freeze/stop other workers (idle workers do no work). Results arrive as pi-subagent-report; do not poll.";
const SPAWN_GUIDELINES = [
	"Do not freeze, pause, or stop other subagents: idle subagents consume no compute and do not interfere. Do not waste a turn stopping them.",
	"Do not poll get_agent or list_agents waiting for the child to finish.",
	"Do not sleep, wait, or tail session/log files to detect completion. The harness delivers reports automatically.",
	"After spawn returns, end your turn or do other independent work, including spawning more agents in parallel.",
	"Do not fabricate, assume, or summarize the child's results before a report arrives.",
] as const;
const SEND_DESCRIPTION =
	"Send a steer or follow-up message to one owned child. You can send to active or finished (done) children; finished children will automatically wake up and resume with their previous session context. Do NOT wait for or ask workers to 'freeze': idle subagents are completely dormant and touch nothing until sent to. Dispatch reviewers or follow-up tasks immediately without wasting turns on freeze ceremonies. Do NOT poll get_agent or list_agents afterwards. Child reports arrive as pi-subagent-report messages that start your next turn.";
const SEND_SNIPPET =
	"Send a message to one owned child (auto-resumes if finished). Reports arrive as pi-subagent-report; do not poll afterwards.";
const GET_DESCRIPTION =
	"Inspect one owned child: state, presentation (panel or background), summary, usage, and whether the view is live or last-known. Use this when you need current identity or state, not to wait for the child to finish.";
const LIST_DESCRIPTION =
	"List available interactive agent definitions and running subagents owned by this parent session. Use this to inspect active subagents or discover interactive agents that can be spawned with spawn_agent, not to wait for work to finish. Reports still arrive as pi-subagent-report messages.";
const LIST_SNIPPET = "List available interactive agent definitions and running subagents.";
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

function spawnFooter(result: AgentToolResult<unknown>): string | undefined {
	const details = result.details as { readonly child?: PublicSubagent } | undefined;
	const child = details?.child;
	if (child !== undefined && typeof child.id === "string") {
		const agent = child.displayName ?? child.agent;
		return `#${child.id} · ${agent}`;
	}
	return undefined;
}

function childStateFooter(result: AgentToolResult<unknown>): string | undefined {
	const details = result.details as { readonly child?: PublicSubagent } | undefined;
	const child = details?.child;
	if (child !== undefined && typeof child.id === "string") {
		return `#${child.id} · ${child.state}`;
	}
	return undefined;
}

function listFooter(result: AgentToolResult<unknown>): string | undefined {
	const details = result.details;
	if (isRecord(details) && Array.isArray(details.runningAgents)) {
		const count = details.runningAgents.length;
		if (count === 0) return undefined;
		return count === 1 ? "1 child" : `${count} children`;
	}
	if (Array.isArray(details)) {
		const count = details.length;
		if (count === 0) return undefined;
		return count === 1 ? "1 child" : `${count} children`;
	}
	return undefined;
}

export function registerParentTools(pi: ExtensionAPI, manager: SubagentManager): void {
	registerToolTuiTrace(pi);
	const tui = getToolTui(pi);
	const spawn: ToolDefinition<typeof spawnSchema> = {
		name: "spawn_agent",
		namespace: SUBAGENTS_NAMESPACE,
		label: "Spawn agent",
		description: SPAWN_DESCRIPTION,
		promptSnippet: SPAWN_SNIPPET,
		promptGuidelines: [...SPAWN_GUIDELINES],
		parameters: spawnSchema,
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
		promptSnippet: SEND_SNIPPET,
		promptGuidelines: [
			"Do not wait for or ask workers to 'freeze': idle subagents are dormant and touch nothing. Dispatch reviewers or follow-ups immediately.",
			"Do not poll get_agent or list_agents afterwards.",
			"Child reports arrive as pi-subagent-report messages that start your next turn.",
		],
		parameters: sendSchema,
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
		promptSnippet: GET_DESCRIPTION,
		parameters: idSchema,
		defaultActive: false,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		async execute(_id, params) {
			return result(await manager.get(params.id));
		},
	};
	const list: ToolDefinition<typeof emptySchema> = {
		name: "list_agents",
		namespace: SUBAGENTS_NAMESPACE,
		label: "List agents",
		description: LIST_DESCRIPTION,
		promptSnippet: LIST_SNIPPET,
		parameters: emptySchema,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const children = await manager.list();
			const cwd =
				ctx !== undefined && typeof ctx === "object" && "cwd" in ctx && typeof ctx.cwd === "string"
					? ctx.cwd
					: process.cwd();
			let allAgents: readonly DiscoveredAgent[];
			try {
				allAgents = await discoverAgents(cwd);
			} catch {
				allAgents = builtinAgents();
			}
			const visible = allAgents.filter(
				(agent) => agent.enabled !== false && agent.frontmatter.hidden !== true,
			);

			const interactiveAgents = visible
				.filter((agent) => agent.frontmatter.interactive === true)
				.map((agent) => ({
					name: agent.name,
					description:
						typeof agent.frontmatter.description === "string" &&
						agent.frontmatter.description.trim() !== ""
							? agent.frontmatter.description.trim()
							: "No description provided.",
				}))
				.sort((a, b) => a.name.localeCompare(b.name));

			const lines: string[] = [];

			if (interactiveAgents.length > 0) {
				lines.push("<interactive_agents>");
				for (const agent of interactiveAgents) {
					lines.push(`- ${agent.name}: ${agent.description}`);
				}
				lines.push("</interactive_agents>");
			}

			if (children.length > 0) {
				if (lines.length > 0) lines.push("");
				lines.push("<running_agents>");
				for (const child of children) {
					const summaryPart = child.summary ? ` | summary: ${child.summary}` : "";
					lines.push(
						`- id: ${child.id} | agent: ${child.agent} | state: ${child.state}${summaryPart}`,
					);
				}
				lines.push("</running_agents>");
			}

			if (lines.length === 0) {
				lines.push("No active or available interactive subagents.");
			}

			return textToolResult(lines.join("\n"), {
				...(interactiveAgents.length > 0 ? { interactiveAgents } : {}),
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
		defaultActive: false,
		annotations: {
			destructiveHint: true,
		},
		async execute(_id, params) {
			return result(await manager.stop(params.id));
		},
	};
	pi.registerTool(
		tui.frame(spawn, {
			summary: (args) => args.agent,
			headerLine: "truncate",
			footer: spawnFooter,
		}),
	);
	pi.registerTool(
		tui.frame(send, {
			summary: (args) => args.id,
			headerLine: "truncate",
			footer: childStateFooter,
		}),
	);
	pi.registerTool(
		tui.frame(get, {
			summary: (args) => args.id,
			headerLine: "truncate",
			footer: childStateFooter,
		}),
	);
	pi.registerTool(
		tui.frame(list, {
			summary: () => "owned children",
			headerLine: "truncate",
			footer: listFooter,
		}),
	);
	pi.registerTool(
		tui.frame(stop, {
			summary: (args) => args.id,
			headerLine: "truncate",
			footer: childStateFooter,
		}),
	);
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
	registerToolTuiTrace(pi);
	const tui = getToolTui(pi);
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
			const details = {
				type: "pi_subagent_report" as const,
				parentSessionId: identity.parentSessionId,
				childId: identity.subagentId,
				runtimeIdentity: identity.runtimeIdentity,
				reason: "blocked" as const,
				message: params.message,
				sessionId,
			};
			await options.report("contact_parent", details, signal);
			return textToolResult("Blocker report queued for the parent.", details);
		},
	};
	pi.registerTool(
		tui.frame(tool, {
			summary: (args) => args.message,
			headerLine: "truncate",
		}),
	);
}
