import { fromJsonSchema, type McpServer, McpServer as Server } from "@modelcontextprotocol/server";
import { discoverAgents } from "./agent-resolver.js";
import { type ControllerReply, callController } from "./controller-ipc.js";
import { isOperationError } from "./domain.js";
import { delegateToolMetadata, parseDelegateInput } from "./mcp/delegate.js";
import { APP_MIME, DASHBOARD_URI, readAppHtml, TASK_CARD_URI } from "./mcp/views.js";
import { type Receipt, terminalReceipt } from "./receipts.js";

const APP_ONLY = { ui: { visibility: ["app"] } } as const;

/**
 * MCP Apps descriptor metadata. `@modelcontextprotocol/ext-apps` is not a dependency: its peers
 * pull React and Zod, and Codex only needs both resource URI keys plus the mcp-app HTML MIME type.
 */
export function createSubagentMcpServer(
	controllerSocket: () => Promise<string>,
	workspace: string,
): McpServer {
	const server = new Server({ name: "pi-subagents", version: "0.7.0" });
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
		"subagents_receipt",
		"Read one delegation receipt for this workspace.",
		idSchema("delegationId"),
		async (args, signal) =>
			forward(
				controllerSocket,
				"receipt",
				{ delegationId: requiredString(args, "delegationId") },
				signal,
			),
	);
	registerAppTool(server, "subagents_dashboard", DASHBOARD_URI, {
		description: "Open the subagent dashboard for this workspace.",
		inputSchema: fromJsonSchema({ type: "object", additionalProperties: false, properties: {} }),
		handler: async (_args: unknown, signal: AbortSignal) => {
			const reply = await callController(
				await controllerSocket(),
				{ op: "list", input: {} },
				signal,
			);
			const payload = toolResult(reply);
			if (!reply.ok || !isChildren(reply.result)) return payload;
			const children = reply.result.children;
			return {
				text: payload.text,
				structuredContent: {
					...payload.structuredContent,
					total: children.length,
					running: children.filter((child) => child.state === "running").length,
					blocked: children.filter((child) => child.state === "blocked").length,
					done: children.filter((child) => child.state === "done").length,
					failed: children.filter((child) => child.state === "error").length,
				},
				isError: false,
			};
		},
	});
	for (const tool of publicTools(controllerSocket)) {
		registerPlain(server, tool.name, tool.description, tool.schema, tool.handler);
	}
	for (const tool of appTools(controllerSocket)) {
		registerPlain(server, tool.name, tool.description, tool.schema, tool.handler, APP_ONLY);
	}
	registerPlain(
		server,
		"subagents_catalog",
		"List agent definitions available to a new subagent.",
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
	registerHtml(server, "Subagent task", TASK_CARD_URI, "task");
	registerHtml(server, "Subagent dashboard", DASHBOARD_URI, "dashboard");
	return server;
}

function publicTools(controllerSocket: () => Promise<string>): Array<{
	name: string;
	description: string;
	schema: Record<string, unknown>;
	handler: (args: unknown, signal: AbortSignal) => Promise<ToolPayload>;
}> {
	return [
		{
			name: "subagents_get",
			description: "Read one subagent's current state and result.",
			schema: idSchema("id"),
			handler: (args, signal) =>
				forward(controllerSocket, "get", { id: requiredString(args, "id") }, signal),
		},
		{
			name: "subagents_stop",
			description: "Stop one subagent runtime and keep its session.",
			schema: idSchema("id"),
			handler: (args, signal) =>
				forward(controllerSocket, "stop", { id: requiredString(args, "id") }, signal),
		},
	];
}

function appTools(controllerSocket: () => Promise<string>): Array<{
	name: string;
	description: string;
	schema: Record<string, unknown>;
	handler: (args: unknown, signal: AbortSignal) => Promise<ToolPayload>;
}> {
	return [
		{
			name: "subagents_list",
			description: "List subagents in this workspace.",
			schema: { type: "object", additionalProperties: false, properties: {} },
			handler: (_args, signal) => forward(controllerSocket, "list", {}, signal),
		},
		{
			name: "subagents_transcript",
			description: "Read one page of a subagent's session history.",
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["id"],
				properties: {
					id: { type: "string", minLength: 1 },
					cursor: { type: "integer", minimum: 0 },
					limit: { type: "integer", minimum: 1, maximum: 50 },
				},
			},
			handler: (args, signal) =>
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
		},
		{
			name: "subagents_receipts",
			description: "List recent delegation receipts.",
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					cursor: { type: "integer", minimum: 0 },
					limit: { type: "integer", minimum: 1, maximum: 50 },
				},
			},
			handler: (args, signal) =>
				forward(
					controllerSocket,
					"receipts",
					{
						cursor: optionalNumber(args, "cursor"),
						limit: optionalNumber(args, "limit"),
					},
					signal,
				),
		},
	];
}

async function forward(
	controllerSocket: () => Promise<string>,
	op: "get" | "list" | "stop" | "transcript" | "receipts" | "receipt",
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
		{
			ui: { resourceUri, visibility: ["model", "app"] },
			"ui/resourceUri": resourceUri,
		},
		tool.inputSchema,
	);
}

function registerPlain(
	server: McpServer,
	name: string,
	description: string,
	schema: Record<string, unknown> | undefined,
	handler: (args: unknown, signal: AbortSignal) => Promise<ToolPayload>,
	meta?: Record<string, unknown>,
	inputSchema = schema === undefined ? undefined : fromJsonSchema(schema),
): void {
	server.registerTool(
		name,
		{
			description,
			...(inputSchema === undefined ? {} : { inputSchema }),
			...(meta === undefined ? {} : { _meta: meta }),
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

interface ToolData {
	error?: string;
	delegationId?: string;
	status?: string;
	childId?: string;
	resultText?: string;
	id?: string;
	state?: string;
	agent?: string;
	displayName?: string;
	task?: string;
	activeTool?: string;
	summary?: string;
	createdAt?: string | number;
	cwd?: string;
	usage?: object;
	children?: readonly object[];
	entries?: readonly unknown[];
	receipts?: readonly object[];
	nextCursor?: number;
	reason?: string;
	operation?: string;
	sideEffects?: readonly string[];
	safeToRetry?: boolean;
	total?: number;
	running?: number;
	blocked?: number;
	done?: number;
	failed?: number;
	agents?: readonly { name: string; enabled: boolean }[];
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
	return {
		text: summarize(reply.result),
		structuredContent: project(reply.result),
		isError: isOperationError(reply.result) || failedReceipt(reply.result),
	};
}

function project(value: Record<string, unknown>): ToolData {
	return {
		...(typeof value.error === "string"
			? { error: value.error }
			: typeof value.interrupted === "string"
				? { error: value.interrupted }
				: {}),
		...(typeof value.delegationId === "string" ? { delegationId: value.delegationId } : {}),
		...(typeof value.status === "string" ? { status: value.status } : {}),
		...(typeof value.childId === "string" ? { childId: value.childId } : {}),
		...(typeof value.resultText === "string" ? { resultText: value.resultText } : {}),
		...(typeof value.id === "string" ? { id: value.id } : {}),
		...(typeof value.state === "string" ? { state: value.state } : {}),
		...(typeof value.agent === "string" ? { agent: value.agent } : {}),
		...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
		...(typeof value.task === "string" ? { task: value.task } : {}),
		...(typeof value.activeTool === "string" ? { activeTool: value.activeTool } : {}),
		...(typeof value.summary === "string" ? { summary: value.summary } : {}),
		...(typeof value.createdAt === "string" || typeof value.createdAt === "number"
			? { createdAt: value.createdAt }
			: {}),
		...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
		...(isRecord(value.usage) ? { usage: value.usage } : {}),
		...(Array.isArray(value.children)
			? { children: value.children.filter(isRecord).map(cleanChild) }
			: {}),
		...(Array.isArray(value.entries) ? { entries: value.entries } : {}),
		...(Array.isArray(value.receipts)
			? { receipts: value.receipts.filter(isRecord).map(cleanReceipt) }
			: {}),
		...(typeof value.nextCursor === "number" ? { nextCursor: value.nextCursor } : {}),
		...(typeof value.reason === "string" ? { reason: value.reason } : {}),
		...(typeof value.operation === "string" ? { operation: value.operation } : {}),
		...(Array.isArray(value.sideEffects)
			? { sideEffects: value.sideEffects.filter(isString) }
			: {}),
		...(typeof value.safeToRetry === "boolean" ? { safeToRetry: value.safeToRetry } : {}),
	};
}

function summarize(value: Record<string, unknown>): string {
	if (isReceipt(value)) return receiptText(value);
	if (isOperationError(value)) return value.reason;
	if (Array.isArray(value.children)) {
		if (value.children.length === 0) return "No subagents";
		const lines = value.children.filter(isRecord).map((child) => {
			const id = child.id ?? "unknown";
			const agent = child.agent ? ` (${child.agent})` : "";
			const state = child.state ?? "";
			const task = child.task ? ` - ${String(child.task).slice(0, 80)}` : "";
			const result =
				typeof child.resultText === "string" && child.resultText
					? `\n  Output: ${child.resultText.trim().replace(/\n/g, "\n  ")}`
					: "";
			const err =
				typeof child.error === "string" && child.error
					? `\n  Error: ${child.error}`
					: typeof child.interrupted === "string" && child.interrupted
						? `\n  Error: ${child.interrupted}`
						: "";
			return `- ${id}${agent}: ${state}${task}${result}${err}`;
		});
		return `${value.children.length} subagents:\n${lines.join("\n")}`;
	}
	if (Array.isArray(value.entries)) return `${value.entries.length} entries`;
	if (Array.isArray(value.receipts)) return `${value.receipts.length} receipts`;
	if (typeof value.id === "string" && typeof value.state === "string") {
		const agent = typeof value.agent === "string" ? ` (${value.agent})` : "";
		const result =
			typeof value.resultText === "string" && value.resultText ? `\n${value.resultText}` : "";
		const summary = typeof value.summary === "string" && value.summary ? `: ${value.summary}` : "";
		const active =
			typeof value.activeTool === "string" && value.activeTool
				? `: running ${value.activeTool}`
				: "";
		const err =
			typeof value.error === "string" && value.error
				? `\nError: ${value.error}`
				: typeof value.interrupted === "string" && value.interrupted
					? `\nError: ${value.interrupted}`
					: "";
		return `${value.id}${agent} ${value.state}${active || summary}${result}${err}`;
	}
	return "ok";
}

function cleanChild(child: Record<string, unknown>): Record<string, unknown> {
	return {
		...(typeof child.id === "string" ? { id: child.id } : {}),
		...(typeof child.agent === "string" ? { agent: child.agent } : {}),
		...(typeof child.displayName === "string" ? { displayName: child.displayName } : {}),
		...(typeof child.state === "string" ? { state: child.state } : {}),
		...(typeof child.task === "string" ? { task: child.task } : {}),
		...(typeof child.summary === "string" ? { summary: child.summary } : {}),
		...(typeof child.activeTool === "string" ? { activeTool: child.activeTool } : {}),
		...(typeof child.resultText === "string" ? { resultText: child.resultText } : {}),
		...(typeof child.delegationId === "string" ? { delegationId: child.delegationId } : {}),
		...(typeof child.cwd === "string" ? { cwd: child.cwd } : {}),
		...(typeof child.error === "string"
			? { error: child.error }
			: typeof child.interrupted === "string"
				? { error: child.interrupted }
				: {}),
	};
}

function cleanReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
	return {
		...(typeof receipt.delegationId === "string" ? { delegationId: receipt.delegationId } : {}),
		...(typeof receipt.childId === "string" ? { childId: receipt.childId } : {}),
		...(typeof receipt.status === "string" ? { status: receipt.status } : {}),
		...(typeof receipt.task === "string" ? { task: receipt.task } : {}),
		...(typeof receipt.resultText === "string" ? { resultText: receipt.resultText } : {}),
	};
}

function failedReceipt(value: Record<string, unknown>): boolean {
	return (
		isReceipt(value) &&
		(value.status === "failed" || value.status === "uncertain" || value.status === "blocked")
	);
}

function receiptText(receipt: Receipt): string {
	const child = receipt.childId === undefined ? "" : ` child ${receipt.childId}`;
	const body = receipt.resultText ?? "";
	const ended = terminalReceipt(receipt.status)
		? receipt.status
		: `${receipt.status}, still running`;
	return `${receipt.delegationId}${child}: ${ended}${body === "" ? "" : `\n${body}`}`;
}

function isReceipt(value: Record<string, unknown>): value is Record<string, unknown> & Receipt {
	return (
		typeof value.delegationId === "string" &&
		typeof value.status === "string" &&
		typeof value.task === "string" &&
		(value.delivery === "pending" || value.delivery === "detached") &&
		typeof value.createdAt === "number" &&
		typeof value.updatedAt === "number"
	);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isChildren(value: unknown): value is { children: Array<{ state?: string }> } {
	return isRecord(value) && Array.isArray(value.children);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
