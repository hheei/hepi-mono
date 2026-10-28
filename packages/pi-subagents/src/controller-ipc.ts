import { chmodSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { ControllerManager } from "./controller-role.js";
import { type DelegationView, historyEntry } from "./delegation.js";
import type { OperationError } from "./domain.js";
import { type DelegateMcpInput, parseDelegateInput } from "./mcp/delegate.js";
import { listReceipts } from "./receipts.js";
import { defaultRegistryPath } from "./registry.js";

const openSockets = new WeakMap<Server, Set<Socket>>();

/** Bumped whenever this call surface changes: a client never talks to a controller from another build. */
export const CONTROLLER_PROTOCOL = 2;

export type ControllerOp =
	| "protocol"
	| "delegate"
	| "receipts"
	| "get"
	| "list"
	| "stop"
	| "transcript";

export interface ControllerCall {
	readonly op: ControllerOp;
	readonly input: unknown;
}

export interface ControllerReply {
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: string;
}

export async function serveControllerIpc(options: {
	readonly socketPath: string;
	readonly parentSessionId: string;
	readonly manager: ControllerManager;
	/** Ledger this controller records delegations in; defaults to this parent's state database. */
	readonly statePath?: string;
}): Promise<Server> {
	try {
		unlinkSync(options.socketPath);
	} catch {
		// A leftover socket is removed only when this owner holds the workspace lock.
	}
	const waiting = { count: 0 };
	const filePath = options.statePath ?? defaultRegistryPath(options.parentSessionId);
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		if (sockets.size >= MAX_CONNECTIONS) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		socket.on("error", () => {});
		const abort = new AbortController();
		socket.once("close", () => {
			sockets.delete(socket);
			abort.abort();
		});
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MAX_FRAME) {
				socket.destroy();
				return;
			}
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				void handleLine(
					socket,
					line,
					options.parentSessionId,
					options.manager,
					abort.signal,
					waiting,
					filePath,
				);
			}
		});
	});
	openSockets.set(server, sockets);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	chmodSync(options.socketPath, 0o600);
	return server;
}

/** Stops listening and drops open calls. `server.close()` alone waits until every wait:true socket ends. */
export function closeControllerIpc(server: Server): Promise<void> {
	const sockets = openSockets.get(server);
	return new Promise((resolve, reject) => {
		server.close((error) => {
			openSockets.delete(server);
			if (error === undefined) resolve();
			else reject(error);
		});
		if (sockets !== undefined) {
			for (const socket of sockets) socket.destroy();
		}
	});
}

/**
 * What answered on this socket. `silent` is not a protocol: a slow or dead peer must not be treated
 * as an older build.
 */
export type ControllerProbe =
	| { readonly state: "ready"; readonly protocol: number }
	| { readonly state: "foreign" }
	| { readonly state: "silent" };

/** The call surface of the controller listening here. Only an actual answer can be foreign. */
export async function controllerProtocol(socketPath: string): Promise<ControllerProbe> {
	try {
		const reply = await callController(
			socketPath,
			{ op: "protocol", input: {} },
			AbortSignal.timeout(2_000),
		);
		const result: unknown = reply.result;
		if (reply.ok !== true || typeof result !== "object" || result === null)
			return { state: "foreign" };
		const protocol = "protocol" in result ? result.protocol : undefined;
		return typeof protocol === "number" ? { state: "ready", protocol } : { state: "foreign" };
	} catch {
		return { state: "silent" };
	}
}

export function callController(
	socketPath: string,
	call: ControllerCall,
	signal?: AbortSignal,
): Promise<ControllerReply> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason instanceof Error ? signal.reason : new Error("Controller call aborted"));
			return;
		}
		const socket = createConnection(socketPath);
		let buffer = "";
		let settled = false;
		const finish = (outcome: { error?: Error; reply?: ControllerReply }): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners();
			socket.on("error", () => {});
			socket.destroy();
			if (outcome.error !== undefined) reject(outcome.error);
			else if (outcome.reply !== undefined) resolve(outcome.reply);
			else reject(new Error("Controller closed the connection without a reply"));
		};
		const onAbort = (): void => {
			const reason = signal?.reason;
			finish({ error: reason instanceof Error ? reason : new Error("Controller call aborted") });
		};
		socket.setEncoding("utf8");
		socket.on("error", (error) => finish({ error }));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			try {
				finish({ reply: parseReply(JSON.parse(buffer.slice(0, newline))) });
			} catch (error) {
				finish({ error: error instanceof Error ? error : new Error(String(error)) });
			}
		});
		socket.on("end", () => finish({}));
		socket.on("close", () => finish({}));
		if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
		socket.write(`${JSON.stringify(call)}\n`);
	});
}

async function handleLine(
	socket: Socket,
	line: string,
	parentSessionId: string,
	manager: ControllerManager,
	signal: AbortSignal,
	waiting: { count: number },
	filePath: string,
): Promise<void> {
	let reply: ControllerReply;
	try {
		const call = parseCall(JSON.parse(line));
		reply = {
			ok: true,
			result: await dispatch(call, parentSessionId, manager, signal, waiting, filePath),
		};
	} catch (error) {
		reply = {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (socket.destroyed || !socket.writable) return;
	socket.write(`${JSON.stringify(reply)}\n`, (error) => {
		if (error !== undefined && error !== null) socket.destroy();
	});
}

const MAX_FRAME = 1024 * 1024;
const MAX_CONNECTIONS = 16;
const MAX_WAITING = 12;

async function dispatch(
	call: ControllerCall,
	parentSessionId: string,
	manager: ControllerManager,
	signal: AbortSignal,
	waiting: { count: number },
	filePath: string,
): Promise<unknown> {
	switch (call.op) {
		case "protocol":
			return { protocol: CONTROLLER_PROTOCOL };
		case "receipts": {
			const page = listReceipts(
				filePath,
				parentSessionId,
				numberField(call.input, "cursor"),
				numberField(call.input, "limit", 50) || 20,
			);
			return {
				receipts: page.receipts.flatMap((receipt) => {
					const entry = historyEntry(receipt);
					return entry === undefined ? [] : [entry];
				}),
				...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
			};
		}
		case "get": {
			const revision = numberField(call.input, "revision");
			return manager.inspect({
				id: stringField(call.input, "id"),
				...(revision === 0 ? {} : { revision }),
				includeOutput: booleanField(call.input, "includeOutput"),
			});
		}
		case "list":
			return manager.dashboard();
		case "stop":
			return manager.stopAgent(stringField(call.input, "id"));
		case "transcript":
			return transcriptPage(manager, stringField(call.input, "id"), call.input);
		case "delegate": {
			const input = parseDelegateInput(call.input);
			return runDelegation(manager, input, signal, waiting);
		}
		default:
			throw new Error(`Unknown controller operation ${call.op}`);
	}
}

async function runDelegation(
	manager: ControllerManager,
	input: DelegateMcpInput,
	signal: AbortSignal,
	waiting: { count: number },
): Promise<DelegationView | OperationError> {
	const wait = input.wait !== false;
	if (wait && waiting.count >= MAX_WAITING) {
		throw new Error("Controller is busy with waiting delegations");
	}
	if (wait) waiting.count += 1;
	try {
		return await manager.delegate(input, signal);
	} finally {
		if (wait) waiting.count -= 1;
	}
}

function parseCall(value: unknown): ControllerCall {
	if (typeof value !== "object" || value === null) throw new Error("Invalid controller call");
	const record = value as Record<string, unknown>;
	if (!isOp(record.op)) throw new Error("Invalid controller call");
	return { op: record.op, input: record.input };
}

const OPS: readonly ControllerOp[] = [
	"protocol",
	"delegate",
	"receipts",
	"get",
	"list",
	"stop",
	"transcript",
];

function isOp(value: unknown): value is ControllerOp {
	return typeof value === "string" && OPS.includes(value as ControllerOp);
}

function parseReply(value: unknown): ControllerReply {
	if (typeof value !== "object" || value === null) throw new Error("Invalid controller reply");
	const record = value as Record<string, unknown>;
	if (typeof record.ok !== "boolean") throw new Error("Invalid controller reply");
	return {
		ok: record.ok,
		...(record.result === undefined ? {} : { result: record.result }),
		...(typeof record.error === "string" ? { error: record.error } : {}),
	};
}

async function transcriptPage(
	manager: ControllerManager,
	id: string,
	input: unknown,
): Promise<{ id: string; entries: unknown[]; nextCursor?: number }> {
	const cursor = numberField(input, "cursor");
	const limit = numberField(input, "limit", 50) || 20;
	const page = await manager.getEntries(id, { cursor, limit });
	if (page === undefined) throw new Error(`Unknown child ${id}`);
	return {
		id,
		entries: page.entries.map(boundedEntry),
		...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
	};
}

function boundedEntry(entry: unknown): unknown {
	try {
		const text = JSON.stringify(entry);
		if (text === undefined) return null;
		if (text.length <= 4000) return JSON.parse(text) as unknown;
		return { truncated: true, text: text.slice(0, 4000) };
	} catch {
		return String(entry);
	}
}

function record(input: unknown): Record<string, unknown> | undefined {
	return typeof input === "object" && input !== null
		? (input as Record<string, unknown>)
		: undefined;
}

function stringField(input: unknown, key: string): string {
	const value = record(input)?.[key];
	if (typeof value !== "string" || value === "") throw new Error(`${key} is required`);
	return value;
}

function numberField(input: unknown, key: string, cap?: number): number {
	const value = record(input)?.[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return 0;
	return cap === undefined ? value : Math.min(value, cap);
}

function booleanField(input: unknown, key: string): boolean {
	return record(input)?.[key] === true;
}
