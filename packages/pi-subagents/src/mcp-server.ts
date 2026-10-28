import { fromJsonSchema, type McpServer, McpServer as Server } from "@modelcontextprotocol/server";
import { discoverAgents } from "./agent-resolver.js";
import { type ControllerReply, callController } from "./controller-ipc.js";
import { isOperationError } from "./domain.js";
import { delegateToolMetadata, parseDelegateInput } from "./mcp/delegate.js";
import { APP_MIME, DASHBOARD_URI, readAppHtml, TASK_CARD_URI } from "./mcp/views.js";

const APP_ONLY = { ui: { visibility: ["app"] } } as const;
const BOTH = { ui: { visibility: ["model", "app"] } } as const;

/**
 * MCP Apps descriptor metadata. The ext-apps package is not a dependency: its peers pull React and
 * Zod, and a host only needs both resource URI keys plus the mcp-app HTML MIME type.
 */
export function createSubagentMcpServer(
	controllerSocket: () => Promise<string>,
	workspace: string,
): McpServer {
	const server = new Server({ name: "pi_agents", version: "0.7.0" });
	registerAppTool(server, delegateToolMetadata.name, TASK_CARD_URI, {
		description: delegateToolMetadata.description,
		inputSchema: fromJsonSchema(delegateToolMetadata.inputSchema),
		handler: async (args: unknown, signal: AbortSignal) => {
			const input = parseDelegateInput(args);
			return toolResult(
				await callController(await controllerSocket(), { op: "delegate", input }, signal),
			);
		},
	});
	registerPlain(
		server,
		"get",
		"Read one agent delegation: the newest by default, or one revision, with its output when asked.",
		{
			type: "object",
			additionalProperties: false,
			required: ["id"],
			properties: {
				id: { type: "string", minLength: 1 },
				revision: { type: "integer", minimum: 1 },
				includeOutput: { type: "boolean" },
			},
		},
		async (args, signal) =>
			forward(
				controllerSocket,
				"get",
				{
					id: requiredString(args, "id"),
					...(optionalPositive(args, "revision") === undefined
						? {}
						: { revision: optionalPositive(args, "revision") }),
					includeOutput: isRecord(args) && args.includeOutput === true,
				},
				signal,
			),
		BOTH,
	);
	registerPlain(
		server,
		"stop",
		"Stop one agent runtime: open delegations fail, finished ones and the session are kept.",
		idSchema("id"),
		async (args, signal) =>
			forward(controllerSocket, "stop", { id: requiredString(args, "id") }, signal),
		BOTH,
	);
	registerAppTool(server, "dashboard", DASHBOARD_URI, {
		description: "List this workspace's agents with their runtime state and latest delegation.",
		inputSchema: fromJsonSchema({ type: "object", additionalProperties: false, properties: {} }),
		handler: async (_args: unknown, signal: AbortSignal) =>
			toolResult(await callController(await controllerSocket(), { op: "list", input: {} }, signal)),
	});
	registerPlain(
		server,
		"list",
		"List this workspace's agents with their runtime state and latest delegation.",
		{ type: "object", additionalProperties: false, properties: {} },
		async (_args, signal) => forward(controllerSocket, "list", {}, signal),
		APP_ONLY,
	);
	registerPlain(
		server,
		"transcript",
		"Read one page of an agent's session history.",
		{
			type: "object",
			additionalProperties: false,
			required: ["id"],
			properties: {
				id: { type: "string", minLength: 1 },
				cursor: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1, maximum: 50 },
			},
		},
		async (args, signal) =>
			forward(
				controllerSocket,
				"transcript",
				{
					id: requiredString(args, "id"),
					cursor: optionalNumber(args, "cursor"),
					limit: optionalNumber(args, "limit"),
				},
				signal,
			),
		APP_ONLY,
	);
	registerPlain(
		server,
		"receipts",
		"List recent delegations of this workspace as id and revision, without their output.",
		{
			type: "object",
			additionalProperties: false,
			properties: {
				cursor: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1, maximum: 50 },
			},
		},
		async (args, signal) =>
			forward(
				controllerSocket,
				"receipts",
				{
					cursor: optionalNumber(args, "cursor"),
					limit: optionalNumber(args, "limit"),
				},
				signal,
			),
		APP_ONLY,
	);
	registerPlain(
		server,
		"catalog",
		"List agent definitions available to a new agent.",
		{ type: "object", additionalProperties: false, properties: {} },
		async () => {
			const agents = await discoverAgents(workspace);
			return {
				text: agents.map((agent) => agent.name).join(", "),
				structuredContent: {
					agents: agents.map((agent) => ({ name: agent.name, enabled: agent.enabled === true })),
				},
				isError: false,
			};
		},
		APP_ONLY,
	);
	registerHtml(server, "Agent task", TASK_CARD_URI, "task");
	registerHtml(server, "Agent dashboard", DASHBOARD_URI, "dashboard");
	return server;
}

async function forward(
	controllerSocket: () => Promise<string>,
	op: "get" | "list" | "stop" | "transcript" | "receipts",
	input: unknown,
	signal: AbortSignal,
): Promise<ToolPayload> {
	return toolResult(await callController(await controllerSocket(), { op, input }, signal));
}

function registerAppTool(
	server: McpServer,
	name: string,
	resourceUri: string,
	tool: {
		description: string;
		inputSchema: ReturnType<typeof fromJsonSchema>;
		handler: (args: unknown, signal: AbortSignal) => Promise<ToolPayload>;
	},
): void {
	registerPlain(
		server,
		name,
		tool.description,
		undefined,
		tool.handler,
		{ ui: { resourceUri, visibility: ["model", "app"] }, "ui/resourceUri": resourceUri },
		tool.inputSchema,
	);
}

function registerPlain(
	server: McpServer,
	name: string,
	description: string,
	schema: Record<string, unknown> | undefined,
	handler: (args: unknown, signal: AbortSignal) => Promise<ToolPayload>,
	visibility?: Record<string, unknown>,
	inputSchema = schema === undefined ? undefined : fromJsonSchema(schema),
): void {
	server.registerTool(
		name,
		{
			description,
			...(inputSchema === undefined ? {} : { inputSchema }),
			...(visibility === undefined ? {} : { _meta: visibility }),
		},
		async (args, ctx) => {
			const payload = await handler(args, ctx.mcpReq.signal);
			return {
				content: [{ type: "text" as const, text: payload.text }],
				structuredContent: payload.structuredContent,
				isError: payload.isError,
			};
		},
	);
}

function registerHtml(
	server: McpServer,
	name: string,
	uri: string,
	kind: "task" | "dashboard",
): void {
	server.registerResource(
		name,
		uri,
		{ mimeType: APP_MIME, description: name },
		async (resource) => ({
			contents: [{ uri: resource.href, mimeType: APP_MIME, text: await readAppHtml(kind) }],
		}),
	);
}

interface DelegationError {
	readonly reason: string;
	readonly safeToRetry: boolean;
	readonly sideEffects: readonly string[];
}

interface DelegationProgress {
	readonly runtimeState: string;
	readonly summary?: string;
	readonly activeTool?: string;
}

interface AgentSummary {
	readonly id: string;
	readonly agent?: string;
	readonly runtimeState: string;
	readonly revision: number;
	readonly status: string;
	readonly hasOutput: boolean;
	readonly summary?: string;
}

interface DelegationHistoryEntry {
	readonly id: string;
	readonly revision: number;
	readonly status: string;
	readonly task: string;
	readonly hasOutput: boolean;
	readonly createdAt: number;
}

interface ToolData {
	error?: string | DelegationError;
	operation?: string;
	id?: string;
	revision?: number;
	status?: string;
	task?: string;
	hasOutput?: boolean;
	resultText?: string;
	agent?: string;
	cwd?: string;
	createdAt?: number;
	delivery?: string;
	progress?: DelegationProgress;
	total?: number;
	running?: number;
	blocked?: number;
	completed?: number;
	failed?: number;
	children?: readonly AgentSummary[];
	entries?: readonly unknown[];
	receipts?: readonly DelegationHistoryEntry[];
	nextCursor?: number;
	agents?: readonly { name: string; enabled: boolean }[];
	sideEffects?: readonly string[];
	safeToRetry?: boolean;
}

interface ToolPayload {
	text: string;
	structuredContent: ToolData;
	isError: boolean;
}

function toolResult(reply: ControllerReply): ToolPayload {
	if (!reply.ok || !isRecord(reply.result)) {
		const error = reply.error ?? "Controller call failed";
		return { text: error, structuredContent: { error }, isError: true };
	}
	const value = reply.result;
	if (isOperationError(value)) {
		return {
			text: value.reason,
			structuredContent: {
				error: value.reason,
				operation: value.operation,
				...(typeof value.id === "string" ? { id: value.id } : {}),
				...(Array.isArray(value.sideEffects)
					? { sideEffects: value.sideEffects.filter(isString) }
					: {}),
				...(typeof value.safeToRetry === "boolean" ? { safeToRetry: value.safeToRetry } : {}),
			},
			isError: true,
		};
	}
	return {
		text: summarize(value),
		structuredContent: project(value),
		isError: failedDelegation(value),
	};
}

function project(value: Record<string, unknown>): ToolData {
	const progress = isRecord(value.progress) ? value.progress : undefined;
	return {
		...(typeof value.id === "string" ? { id: value.id } : {}),
		...(typeof value.revision === "number" ? { revision: value.revision } : {}),
		...(typeof value.status === "string" ? { status: value.status } : {}),
		...(typeof value.task === "string" ? { task: value.task } : {}),
		...(typeof value.hasOutput === "boolean" ? { hasOutput: value.hasOutput } : {}),
		...(typeof value.resultText === "string" ? { resultText: value.resultText } : {}),
		...(typeof value.agent === "string" ? { agent: value.agent } : {}),
		...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
		...(typeof value.createdAt === "number" ? { createdAt: value.createdAt } : {}),
		...(typeof value.delivery === "string" ? { delivery: value.delivery } : {}),
		...(progress === undefined
			? {}
			: {
					progress: {
						runtimeState:
							typeof progress.runtimeState === "string" ? progress.runtimeState : "unknown",
						...(typeof progress.summary === "string" ? { summary: progress.summary } : {}),
						...(typeof progress.activeTool === "string" ? { activeTool: progress.activeTool } : {}),
					},
				}),
		...(isRecord(value.error) ? { error: cleanError(value.error) } : {}),
		...(typeof value.total === "number" ? { total: value.total } : {}),
		...(typeof value.running === "number" ? { running: value.running } : {}),
		...(typeof value.blocked === "number" ? { blocked: value.blocked } : {}),
		...(typeof value.completed === "number" ? { completed: value.completed } : {}),
		...(typeof value.failed === "number" ? { failed: value.failed } : {}),
		...(Array.isArray(value.children)
			? { children: value.children.filter(isRecord).map(cleanChild) }
			: {}),
		...(Array.isArray(value.entries) ? { entries: value.entries } : {}),
		...(Array.isArray(value.receipts)
			? { receipts: value.receipts.filter(isRecord).map(cleanHistory) }
			: {}),
		...(typeof value.nextCursor === "number" ? { nextCursor: value.nextCursor } : {}),
	};
}

function cleanError(error: Record<string, unknown>): DelegationError {
	return {
		reason: typeof error.reason === "string" ? error.reason : "Delegation failed",
		safeToRetry: error.safeToRetry === true,
		sideEffects: Array.isArray(error.sideEffects) ? error.sideEffects.filter(isString) : [],
	};
}

function summarize(value: Record<string, unknown>): string {
	if (Array.isArray(value.children)) {
		const counts = ["total", "running", "blocked", "completed", "failed"]
			.filter((key) => typeof value[key] === "number")
			.map((key) => `${key} ${String(value[key])}`)
			.join(" · ");
		const lines = value.children.filter(isRecord).map((child) => {
			const agent = typeof child.agent === "string" ? ` (${child.agent})` : "";
			const state = typeof child.runtimeState === "string" ? child.runtimeState : "unknown";
			const status = typeof child.status === "string" ? ` / ${child.status}` : "";
			const revision = typeof child.revision === "number" ? ` · rev ${child.revision}` : "";
			const summary = typeof child.summary === "string" ? ` — ${child.summary}` : "";
			return `- ${String(child.id)}${agent}: ${state}${status}${revision}${summary}`;
		});
		const head = value.children.length === 0 ? "No agents" : counts;
		return lines.length === 0 ? head : `${head}\n${lines.join("\n")}`;
	}
	if (Array.isArray(value.entries)) return `${value.entries.length} entries`;
	if (Array.isArray(value.receipts)) return `${value.receipts.length} receipts`;
	if (typeof value.id === "string" && typeof value.status === "string") {
		const agent = typeof value.agent === "string" ? ` (${value.agent})` : "";
		const revision = typeof value.revision === "number" ? ` · rev ${value.revision}` : "";
		const progress = isRecord(value.progress) ? value.progress : undefined;
		const runtime =
			progress !== undefined && typeof progress.runtimeState === "string"
				? ` (${progress.runtimeState})`
				: "";
		const active =
			progress !== undefined &&
			typeof progress.activeTool === "string" &&
			progress.activeTool !== ""
				? `: running ${progress.activeTool}`
				: "";
		const error =
			isRecord(value.error) && typeof value.error.reason === "string"
				? `\nError: ${value.error.reason}`
				: "";
		const body =
			typeof value.resultText === "string" && value.resultText !== ""
				? `\n${value.resultText}`
				: value.hasOutput === true
					? "\nThe output was not requested; read it with includeOutput."
					: "";
		return `${value.id}${agent} ${value.status}${runtime}${revision}${active}${error}${body}`;
	}
	return "ok";
}

function cleanChild(child: Record<string, unknown>): AgentSummary {
	return {
		id: typeof child.id === "string" ? child.id : "",
		...(typeof child.agent === "string" ? { agent: child.agent } : {}),
		runtimeState: typeof child.runtimeState === "string" ? child.runtimeState : "unknown",
		revision: typeof child.revision === "number" ? child.revision : 0,
		status: typeof child.status === "string" ? child.status : "unknown",
		hasOutput: child.hasOutput === true,
		...(typeof child.summary === "string" ? { summary: child.summary } : {}),
	};
}

function cleanHistory(receipt: Record<string, unknown>): DelegationHistoryEntry {
	return {
		id: typeof receipt.id === "string" ? receipt.id : "",
		revision: typeof receipt.revision === "number" ? receipt.revision : 0,
		status: typeof receipt.status === "string" ? receipt.status : "unknown",
		task: typeof receipt.task === "string" ? receipt.task : "",
		hasOutput: receipt.hasOutput === true,
		createdAt: typeof receipt.createdAt === "number" ? receipt.createdAt : 0,
	};
}

function failedDelegation(value: Record<string, unknown>): boolean {
	return value.status === "failed" || value.status === "uncertain" || value.status === "blocked";
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function idSchema(name: string): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		required: [name],
		properties: { [name]: { type: "string", minLength: 1 } },
	};
}

function requiredString(args: unknown, key: string): string {
	const value = isRecord(args) ? args[key] : undefined;
	if (typeof value !== "string" || value === "") throw new Error(`${key} is required`);
	return value;
}

function optionalNumber(args: unknown, key: string): number | undefined {
	if (!isRecord(args) || args[key] === undefined) return undefined;
	const value = args[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${key} must be an integer`);
	}
	return value;
}

function optionalPositive(args: unknown, key: string): number | undefined {
	const value = optionalNumber(args, key);
	if (value === undefined) return undefined;
	if (value < 1) throw new Error(`${key} must be a positive integer`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
