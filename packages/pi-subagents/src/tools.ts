import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getToolTui, registerToolTuiTrace, textToolResult } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { sendReportToRunner } from "./connector.js";
import { type ChildIdentity, isOperationError, type PublicSubagent } from "./domain.js";

import type { SubagentManager } from "./manager.js";

const spawnSchema = Type.Object({
	task: Type.String({ minLength: 1 }),
	agent: Type.String({
		minLength: 1,
		description: "Name of an agent defined in .pi/agents/*.md or ~/.pi/agent/agents/*.md",
	}),
	cwd: Type.Optional(Type.String()),
});
const sendSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	message: Type.String({ minLength: 1 }),
	mode: Type.Optional(
		Type.Union([Type.Literal("steer"), Type.Literal("follow_up"), Type.Literal("auto")]),
	),
});
const idSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const contactSchema = Type.Object({
	reason: Type.Union([
		Type.Literal("progress_update"),
		Type.Literal("important_finding"),
		Type.Literal("need_decision"),
		Type.Literal("blocked"),
	]),
	message: Type.String({ minLength: 1 }),
});
const emptySchema = Type.Object({});

function result(value: unknown): AgentToolResult<unknown> {
	if (isOperationError(value)) throw new Error(JSON.stringify(value));
	return textToolResult(typeof value === "string" ? value : JSON.stringify(value), value);
}

const SPAWN_DESCRIPTION =
	"Start an independent background RPC subagent. This call waits until the child runtime is ready, then returns the child id and initial state. Do NOT poll get_subagent or list_subagents to wait for the child's work. When the child reports via contact_parent, the harness delivers that report as a pi-subagent-report message and starts your next turn; while you are idle, reports from several children may arrive together in one such message. After this tool returns, either end your turn or work on other independent tasks, including spawning more subagents in parallel. Do not fabricate or assume the child's results.";
const SPAWN_SNIPPET =
	"Start a background RPC subagent. Returns when the runtime is ready. Results arrive later as pi-subagent-report; do not poll.";
const SPAWN_GUIDELINES = [
	"Do not poll get_subagent or list_subagents waiting for the child to finish.",
	"Do not sleep, wait, or tail session/log files to detect completion. The harness delivers reports.",
	"When the child calls contact_parent, a pi-subagent-report message starts your next turn.",
	"After spawn returns, end your turn or do other independent work, including more parallel spawns.",
	"Do not fabricate, assume, or summarize the child's results before a report arrives.",
	"Prefer `task` for a review, an audit, or reconnaissance whose findings you need before your next step — it waits for the result by default; `spawn_subagent` is for a partner you will talk to again.",
] as const;
const SEND_DESCRIPTION =
	"Send a steer or follow-up message to one owned child. You can send to active or finished (done) children; finished children will automatically wake up and resume with their previous session context. Do NOT poll get_subagent or list_subagents afterwards. Child reports arrive as pi-subagent-report messages that start your next turn.";
const SEND_SNIPPET =
	"Send a message to one owned child (auto-resumes if finished). Reports arrive as pi-subagent-report; do not poll afterwards.";
const GET_DESCRIPTION =
	"Inspect one owned child: state, mode, summary, usage, and whether the view is live or last-known. Use this when you need current identity or state, not to wait for the child to finish.";
const LIST_DESCRIPTION =
	"List children owned by this parent session. Use this when you need ids or current state, not to wait for work to finish. Reports still arrive as pi-subagent-report messages.";
const STOP_DESCRIPTION = "Persist a stopped intent, then end that child's runtime.";
const CONTACT_DESCRIPTION =
	"Report progress, an important finding, a decision you need, or a blocker to the parent. The parent is woken automatically; do not retry the same report. After need_decision or blocked, wait for a parent send_subagent. Do not invent new authority.";
const CONTACT_SNIPPET =
	"Report to the parent. The parent is woken automatically; do not retry the same report.";
const CONTACT_GUIDELINES = [
	"Call contact_parent when the parent needs a progress update, finding, decision, or blocker.",
	"Do not send empty status pings or retry the same report.",
	"After need_decision or blocked, wait for a parent send_subagent. Do not invent new authority.",
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

function listFooter(result: AgentToolResult<unknown>): string | undefined {
	const details = result.details as readonly unknown[] | undefined;
	if (Array.isArray(details)) {
		const count = details.length;
		return count === 1 ? "1 child" : `${count} children`;
	}
	return undefined;
}

export function registerParentTools(pi: ExtensionAPI, manager: SubagentManager): void {
	registerToolTuiTrace(pi);
	const tui = getToolTui(pi);
	const spawn: ToolDefinition<typeof spawnSchema> = {
		name: "spawn_subagent",
		label: "Spawn subagent",
		description: SPAWN_DESCRIPTION,
		promptSnippet: SPAWN_SNIPPET,
		promptGuidelines: [...SPAWN_GUIDELINES],
		parameters: spawnSchema,
		async execute(_id, params) {
			return result(await manager.spawn(params));
		},
	};
	const send: ToolDefinition<typeof sendSchema> = {
		name: "send_subagent",
		label: "Send to subagent",
		description: SEND_DESCRIPTION,
		promptSnippet: SEND_SNIPPET,
		promptGuidelines: [
			"Do not poll get_subagent or list_subagents afterwards.",
			"Child reports arrive as pi-subagent-report messages that start your next turn.",
		],
		parameters: sendSchema,
		async execute(_id, params, signal) {
			return result(await manager.send(params.id, params.message, params.mode, signal));
		},
	};
	const get: ToolDefinition<typeof idSchema> = {
		name: "get_subagent",
		label: "Get subagent",
		description: GET_DESCRIPTION,
		promptSnippet: GET_DESCRIPTION,
		parameters: idSchema,
		async execute(_id, params) {
			return result(await manager.get(params.id));
		},
	};
	const list: ToolDefinition<typeof emptySchema> = {
		name: "list_subagents",
		label: "List subagents",
		description: LIST_DESCRIPTION,
		promptSnippet: LIST_DESCRIPTION,
		parameters: emptySchema,
		async execute() {
			return result(await manager.list());
		},
	};
	const stop: ToolDefinition<typeof idSchema> = {
		name: "stop_subagent",
		label: "Stop subagent",
		description: STOP_DESCRIPTION,
		parameters: idSchema,
		async execute(_id, params, signal) {
			return result(await manager.stop(params.id, signal));
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
		}),
	);
	pi.registerTool(
		tui.frame(get, {
			summary: (args) => args.id,
			headerLine: "truncate",
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
		}),
	);
}

export interface RegisterChildToolsOptions {
	readonly onReport?: () => void;
	readonly isBound?: (sessionId: string) => boolean;
}

export function registerChildTools(
	pi: ExtensionAPI,
	identity: ChildIdentity,
	options: RegisterChildToolsOptions = {},
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
				reason: params.reason,
				message: params.message,
				sessionId,
			};
			await sendReportToRunner(identity, details, signal);
			options.onReport?.();
			return textToolResult("Report queued for the parent.", details);
		},
	};
	pi.registerTool(
		tui.frame(tool, {
			summary: (args) => args.reason,
			headerLine: "truncate",
		}),
	);
}
