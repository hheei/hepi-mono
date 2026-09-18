import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sendReportToRunner } from "./connector.js";
import type { ChildIdentity, OperationError } from "./domain.js";
import { isRecord } from "./domain.js";
import type { SubagentManager } from "./manager.js";

const spawnSchema = Type.Object({
	task: Type.String({ minLength: 1 }),
	agent: Type.Optional(Type.String()),
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

function isOperationError(value: unknown): value is OperationError {
	return (
		isRecord(value) &&
		typeof value.operation === "string" &&
		typeof value.reason === "string" &&
		Array.isArray(value.sideEffects)
	);
}

function result(value: unknown): AgentToolResult<unknown> {
	if (isOperationError(value)) throw new Error(JSON.stringify(value));
	return {
		content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
		details: value,
	};
}

export function registerParentTools(pi: ExtensionAPI, manager: SubagentManager): void {
	const spawn: ToolDefinition<typeof spawnSchema> = {
		name: "spawn_subagent",
		label: "Spawn subagent",
		description: "Start an independent RPC subagent.",
		parameters: spawnSchema,
		async execute(_id, params) {
			return result(await manager.spawn(params));
		},
	};
	const send: ToolDefinition<typeof sendSchema> = {
		name: "send_subagent",
		label: "Send to subagent",
		description: "Send a steer or follow-up message.",
		parameters: sendSchema,
		async execute(_id, params, signal) {
			return result(await manager.send(params.id, params.message, params.mode, signal));
		},
	};
	const get: ToolDefinition<typeof idSchema> = {
		name: "get_subagent",
		label: "Get subagent",
		description: "Inspect one subagent.",
		parameters: idSchema,
		async execute(_id, params) {
			return result(await manager.get(params.id));
		},
	};
	const list: ToolDefinition<typeof emptySchema> = {
		name: "list_subagents",
		label: "List subagents",
		description: "List owned subagents.",
		parameters: emptySchema,
		async execute() {
			return result(await manager.list());
		},
	};
	const stop: ToolDefinition<typeof idSchema> = {
		name: "stop_subagent",
		label: "Stop subagent",
		description: "Stop a subagent.",
		parameters: idSchema,
		async execute(_id, params, signal) {
			return result(await manager.stop(params.id, signal));
		},
	};
	for (const tool of [spawn, send, get, list, stop]) pi.registerTool(tool);
}

export function registerChildTools(pi: ExtensionAPI, identity: ChildIdentity): void {
	const tool: ToolDefinition<typeof contactSchema> = {
		name: "contact_parent",
		label: "Contact parent",
		description: "Report progress, findings, decisions, or blockers to the parent.",
		parameters: contactSchema,
		async execute(_id, params, signal) {
			const details = {
				type: "pi_subagent_report" as const,
				parentSessionId: identity.parentSessionId,
				childId: identity.subagentId,
				runtimeIdentity: identity.runtimeIdentity,
				reason: params.reason,
				message: params.message,
			};
			await sendReportToRunner(identity, details, signal);
			return {
				content: [{ type: "text", text: "Report queued for the parent." }],
				details,
			};
		},
	};
	pi.registerTool(tool);
}

export function isChildEnvironment(
	env: NodeJS.ProcessEnv,
): env is NodeJS.ProcessEnv &
	Record<
		| "PI_SUBAGENTS_PARENT_SESSION_ID"
		| "PI_SUBAGENTS_CHILD_ID"
		| "PI_SUBAGENTS_RUNTIME_ID"
		| "PI_SUBAGENTS_ENDPOINT"
		| "PI_SUBAGENTS_TOKEN",
		string
	> {
	const keys = [
		"PI_SUBAGENTS_PARENT_SESSION_ID",
		"PI_SUBAGENTS_CHILD_ID",
		"PI_SUBAGENTS_RUNTIME_ID",
		"PI_SUBAGENTS_ENDPOINT",
		"PI_SUBAGENTS_TOKEN",
	] as const;
	return keys.every((key) => typeof env[key] === "string" && env[key] !== "");
}
