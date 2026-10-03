import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChildBridgeServer, type ChildRequest } from "../src/bridge-server.js";
import { PROTOCOL_VERSION } from "../src/domain.js";
import { attachJsonLineReader, serializeJsonLine } from "../src/json-lines.js";
import type { HelloFrame } from "../src/protocol.js";
import { BridgeError } from "../src/protocol.js";

interface RawChild {
	readonly frames: unknown[];
	readonly socket: Socket;
	send(frame: unknown): void;
	next(predicate: (value: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
	destroy(): void;
}

interface BridgeFixture {
	readonly endpoint: string;
	readonly server: ChildBridgeServer;
	readonly events: Array<{ childId: string; event: unknown }>;
	readonly connections: Array<{ childId: string; connected: boolean }>;
	readonly diagnoses: string[];
	readonly requests: ChildRequest[];
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const step of cleanup.splice(0)) await step();
});

async function tempEndpoint(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-bridge-"));
	cleanup.push(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	return join(dir, "parent.sock");
}

function helloFrame(overrides: Partial<HelloFrame> = {}): HelloFrame {
	return {
		version: PROTOCOL_VERSION,
		type: "hello",
		role: "child",
		parentSessionId: "parent-1",
		subagentId: "agent-1",
		runtimeIdentity: "runtime-1",
		endpoint: "/tmp/parent.sock",
		token: "token-1",
		...overrides,
	};
}

async function startServer(options: {
	endpoint: string;
	authorize?: (frame: HelloFrame) => string | undefined | Promise<string | undefined>;
	handleRequest?: (request: ChildRequest) => Promise<unknown>;
	requestTimeoutMs?: number;
}): Promise<BridgeFixture> {
	const events: BridgeFixture["events"] = [];
	const connections: BridgeFixture["connections"] = [];
	const diagnoses: string[] = [];
	const requests: ChildRequest[] = [];
	const server = new ChildBridgeServer({
		endpoint: options.endpoint,
		parentSessionId: "parent-1",
		authorize: options.authorize ?? (() => undefined),
		handleRequest: async (request) => {
			requests.push(request);
			return await (options.handleRequest?.(request) ?? { ok: true });
		},
		diagnose: (message) => diagnoses.push(message),
		...(options.requestTimeoutMs === undefined
			? {}
			: { requestTimeoutMs: options.requestTimeoutMs }),
	});
	server.onEvent((childId, event) => events.push({ childId, event }));
	server.onConnectionChange((childId, connected) => connections.push({ childId, connected }));
	await server.listen();
	cleanup.push(async () => {
		await server.close();
	});
	return { endpoint: options.endpoint, server, events, connections, diagnoses, requests };
}

async function connectChild(endpoint: string): Promise<RawChild> {
	const socket = connect(endpoint);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
	const frames: unknown[] = [];
	const waiters: Array<{
		predicate: (value: unknown) => boolean;
		resolve: (value: unknown) => void;
	}> = [];
	attachJsonLineReader(socket, {
		maxFrameBytes: 1024 * 1024,
		onValue: (value) => {
			frames.push(value);
			for (const waiter of [...waiters]) {
				if (!waiter.predicate(value)) continue;
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(value);
			}
		},
		onError: () => {},
	});
	return {
		frames,
		socket,
		send: (frame) => {
			socket.write(serializeJsonLine(frame, 1024 * 1024));
		},
		next: (predicate, timeoutMs = 2_000) =>
			new Promise((resolve, reject) => {
				const existing = frames.find(predicate);
				if (existing !== undefined) {
					resolve(existing);
					return;
				}
				const timer = setTimeout(() => reject(new Error("frame was not received")), timeoutMs);
				waiters.push({
					predicate,
					resolve: (value) => {
						clearTimeout(timer);
						resolve(value);
					},
				});
			}),
		destroy: () => socket.destroy(),
	};
}

function isRecordFrame(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function frameWithType(type: string): (value: unknown) => boolean {
	return (value) => isRecordFrame(value) && value.type === type;
}

describe("ChildBridgeServer", () => {
	test("accepts an authenticated hello and answers hello_ack", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		const child = await connectChild(endpoint);
		child.send(helloFrame());

		const ack = await child.next(frameWithType("hello_ack"));
		expect(ack).toMatchObject({ version: PROTOCOL_VERSION, type: "hello_ack" });
		expect(fixture.server.isConnected("agent-1")).toBe(true);
		expect(fixture.server.connectedChildren()).toEqual(["agent-1"]);
		expect(fixture.connections).toEqual([{ childId: "agent-1", connected: true }]);
	});

	test("refuses a hello for another parent session", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		const child = await connectChild(endpoint);
		child.send(helloFrame({ parentSessionId: "parent-2" }));

		await vi.waitFor(() => {
			expect(fixture.server.connectedChildren()).toEqual([]);
		});
		await vi.waitFor(() => {
			expect(child.socket.destroyed).toBe(true);
		});
		expect(fixture.diagnoses.some((line) => line.includes("another parent session"))).toBe(true);
	});

	test("refuses a hello the runtime token check rejects", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({
			endpoint,
			authorize: (frame) => (frame.token === "expected" ? undefined : "runtime token mismatch"),
		});
		const child = await connectChild(endpoint);
		child.send(helloFrame());

		await vi.waitFor(() => {
			expect(child.socket.destroyed).toBe(true);
		});
		expect(fixture.server.connectedChildren()).toEqual([]);
		expect(fixture.diagnoses.some((line) => line.includes("runtime token mismatch"))).toBe(true);
	});

	test("resolves a parent request from the child's response", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		const child = await connectChild(endpoint);
		child.send(helloFrame());
		await child.next(frameWithType("hello_ack"));

		const pending = fixture.server.request("agent-1", "get_state");
		const request = await child.next(frameWithType("request"));
		expect(request).toMatchObject({ operation: "get_state" });
		const id = isRecordFrame(request) ? String(request.id) : "";
		child.send({
			version: PROTOCOL_VERSION,
			type: "response",
			id,
			ok: true,
			data: { idle: false },
		});

		await expect(pending).resolves.toEqual({ idle: false });
	});

	test("fails a parent request that the child never answers", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint, requestTimeoutMs: 30 });
		const child = await connectChild(endpoint);
		child.send(helloFrame());
		await child.next(frameWithType("hello_ack"));

		await expect(fixture.server.request("agent-1", "get_state")).rejects.toThrow(BridgeError);
		await expect(fixture.server.request("agent-1", "get_state")).rejects.toMatchObject({
			code: "timeout",
		});
	});

	test("fails in-flight requests when the child disconnects", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		const child = await connectChild(endpoint);
		child.send(helloFrame());
		await child.next(frameWithType("hello_ack"));

		const pending = fixture.server.request("agent-1", "get_entries");
		child.destroy();

		await expect(pending).rejects.toMatchObject({ code: "connection_lost" });
		await vi.waitFor(() => {
			expect(fixture.connections).toEqual([
				{ childId: "agent-1", connected: true },
				{ childId: "agent-1", connected: false },
			]);
		});
		expect(fixture.server.isConnected("agent-1")).toBe(false);
	});

	test("refuses a parent request while the child is not connected", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		await expect(fixture.server.request("agent-1", "get_state")).rejects.toMatchObject({
			code: "child_not_connected",
		});
	});

	test("serves child-initiated requests and reports handler failures", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({
			endpoint,
			handleRequest: async (request) => {
				if (request.operation === "contact_parent") return { delivered: true };
				throw new BridgeError("report_queue_full", "no room for reports");
			},
		});
		const child = await connectChild(endpoint);
		child.send(helloFrame());
		await child.next(frameWithType("hello_ack"));

		child.send({
			version: PROTOCOL_VERSION,
			type: "request",
			id: "report-1",
			operation: "contact_parent",
			payload: { message: "progress" },
		});
		await expect(
			child.next((value) => isRecordFrame(value) && value.id === "report-1"),
		).resolves.toMatchObject({ ok: true, data: { delivered: true } });

		child.send({
			version: PROTOCOL_VERSION,
			type: "request",
			id: "report-2",
			operation: "task_result",
			payload: {},
		});
		await expect(
			child.next((value) => isRecordFrame(value) && value.id === "report-2"),
		).resolves.toMatchObject({ ok: false, error: { code: "report_queue_full" } });
		expect(fixture.requests.map((entry) => entry.operation)).toEqual([
			"contact_parent",
			"task_result",
		]);
	});

	test("answers a repeated report from the first result instead of acting twice", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		const child = await connectChild(endpoint);
		child.send(helloFrame());
		await child.next(frameWithType("hello_ack"));

		const frame = {
			version: PROTOCOL_VERSION,
			type: "request",
			id: "report-1",
			operation: "contact_parent",
			payload: { message: "progress" },
		};
		child.send(frame);
		await child.next(
			(value) => isRecordFrame(value) && value.id === "report-1" && value.ok === true,
		);
		// The child lost the answer and sent the same report again: it hears the same answer, and the
		// parent sees one delivery.
		child.send(frame);
		await expect(
			child.next((value) => isRecordFrame(value) && value.id === "report-1"),
		).resolves.toMatchObject({ ok: true });
		expect(fixture.requests).toHaveLength(1);
	});

	test("shares one answer with a report that arrives twice in flight", async () => {
		const endpoint = await tempEndpoint();
		let release: (() => void) | undefined;
		const fixture = await startServer({
			endpoint,
			handleRequest: () =>
				new Promise((resolve) => {
					release = () => resolve({ ok: true });
				}),
		});
		const child = await connectChild(endpoint);
		child.send(helloFrame());
		await child.next(frameWithType("hello_ack"));

		const frame = {
			version: PROTOCOL_VERSION,
			type: "request",
			id: "report-1",
			operation: "contact_parent",
			payload: { message: "progress" },
		};
		child.send(frame);
		// The same request arrives again while the first copy is still being handled — a lost answer,
		// or a child that reconnected. Both askers are waiting for the one result the parent is
		// producing, so neither may be refused: a refusal here drops a report the parent already acted on.
		child.send(frame);
		await vi.waitFor(() => expect(release).toBeDefined());
		release?.();
		await vi.waitFor(() => {
			expect(
				child.frames.filter(
					(value) => isRecordFrame(value) && value.id === "report-1" && value.ok === true,
				),
			).toHaveLength(2);
		});
		expect(fixture.requests).toHaveLength(1);
		expect(child.frames.some((value) => isRecordFrame(value) && isRecordFrame(value.error))).toBe(
			false,
		);
	});

	test("does not answer a new runtime from the previous runtime's request ids", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		const first = await connectChild(endpoint);
		first.send(helloFrame());
		await first.next(frameWithType("hello_ack"));
		first.send({
			version: PROTOCOL_VERSION,
			type: "request",
			id: "report-1",
			operation: "contact_parent",
			payload: { message: "progress" },
		});
		await first.next(
			(value) => isRecordFrame(value) && value.id === "report-1" && value.ok === true,
		);
		first.destroy();

		// The same child resumed in a new process: it counts its request ids from one again, so its
		// first report must be delivered rather than answered with the previous runtime's result.
		const second = await connectChild(endpoint);
		second.send(helloFrame({ runtimeIdentity: "runtime-2" }));
		await second.next(frameWithType("hello_ack"));
		second.send({
			version: PROTOCOL_VERSION,
			type: "request",
			id: "report-1",
			operation: "contact_parent",
			payload: { message: "second runtime" },
		});
		await expect(
			second.next((value) => isRecordFrame(value) && value.id === "report-1"),
		).resolves.toMatchObject({ ok: true });
		expect(fixture.requests.map((request) => request.runtimeIdentity)).toEqual([
			"runtime-1",
			"runtime-2",
		]);
	});

	test("replays a report answer for a child that reconnected", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		const first = await connectChild(endpoint);
		first.send(helloFrame());
		await first.next(frameWithType("hello_ack"));
		first.send({
			version: PROTOCOL_VERSION,
			type: "request",
			id: "report-1",
			operation: "contact_parent",
			payload: { message: "progress" },
		});
		await first.next((value) => isRecordFrame(value) && value.id === "report-1");
		first.socket.destroy();

		// The child reconnects with the same identity and re-sends the report it never saw an answer
		// for: the parent answers from the first result.
		const second = await connectChild(endpoint);
		second.send(helloFrame());
		await second.next(frameWithType("hello_ack"));
		second.send({
			version: PROTOCOL_VERSION,
			type: "request",
			id: "report-1",
			operation: "contact_parent",
			payload: { message: "progress" },
		});
		await expect(
			second.next((value) => isRecordFrame(value) && value.id === "report-1"),
		).resolves.toMatchObject({ ok: true });
		expect(fixture.requests).toHaveLength(1);
	});

	test("forwards events a child pushes", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		const child = await connectChild(endpoint);
		child.send(helloFrame());
		await child.next(frameWithType("hello_ack"));

		child.send({
			version: PROTOCOL_VERSION,
			type: "event",
			event: { type: "agent_start" },
		});
		await vi.waitFor(() => {
			expect(fixture.events).toEqual([{ childId: "agent-1", event: { type: "agent_start" } }]);
		});
	});

	test("replaces the previous connection when the child reconnects", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		const first = await connectChild(endpoint);
		first.send(helloFrame());
		await first.next(frameWithType("hello_ack"));

		const pending = fixture.server.request("agent-1", "get_state").catch((error: unknown) => error);
		const second = await connectChild(endpoint);
		second.send(helloFrame({ runtimeIdentity: "runtime-1" }));
		await second.next(frameWithType("hello_ack"));

		await expect(pending).resolves.toMatchObject({ code: "connection_lost" });
		await vi.waitFor(() => {
			expect(first.socket.destroyed).toBe(true);
		});
		expect(fixture.server.isConnected("agent-1")).toBe(true);
		expect(fixture.connections).toEqual([{ childId: "agent-1", connected: true }]);

		// The new connection is the one that answers now.
		const request = fixture.server.request("agent-1", "get_state");
		const frame = await second.next(frameWithType("request"));
		const id = isRecordFrame(frame) ? String(frame.id) : "";
		second.send({
			version: PROTOCOL_VERSION,
			type: "response",
			id,
			ok: true,
			data: { idle: true },
		});
		await expect(request).resolves.toEqual({ idle: true });
	});

	test("refuses an endpoint another live bridge server owns", async () => {
		const endpoint = await tempEndpoint();
		await startServer({ endpoint });
		const second = new ChildBridgeServer({
			endpoint,
			parentSessionId: "parent-1",
			authorize: () => undefined,
			handleRequest: async () => ({}),
		});
		await expect(second.listen()).rejects.toThrow(/already owns endpoint/);
	});

	test("replaces a socket left behind by a dead server", async () => {
		const endpoint = await tempEndpoint();
		const first = await startServer({ endpoint });
		await first.server.close();
		await expect(stat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });

		const second = await startServer({ endpoint });
		expect(second.server.isConnected("agent-1")).toBe(false);
	});

	test("closes connections and removes its socket", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		const child = await connectChild(endpoint);
		child.send(helloFrame());
		await child.next(frameWithType("hello_ack"));

		const pending = fixture.server.request("agent-1", "get_state").catch((error: unknown) => error);
		await fixture.server.close();

		await expect(pending).resolves.toMatchObject({ code: "connection_lost" });
		await expect(stat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
	});
	test("ends a handshake that is still being authorized when the server closes", async () => {
		const endpoint = await tempEndpoint();
		let release: (() => void) | undefined;
		const fixture = await startServer({
			endpoint,
			authorize: () =>
				new Promise<string | undefined>((resolve) => {
					release = () => resolve(undefined);
				}),
		});
		const child = await connectChild(endpoint);
		child.send(helloFrame());
		await new Promise((resolve) => setTimeout(resolve, 50));

		// The socket of an unfinished handshake is not in the connection table yet, so closing must
		// end it here; otherwise the server waits forever for the late hello_ack.
		await expect(fixture.server.close()).resolves.toBeUndefined();
		release?.();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fixture.server.isConnected("agent-1")).toBe(false);
		expect(fixture.connections).not.toContain(true);
	});
	test("ends a child's connection on request and says so", async () => {
		const endpoint = await tempEndpoint();
		const fixture = await startServer({ endpoint });
		const child = await connectChild(endpoint);
		child.send(helloFrame());
		await child.next(frameWithType("hello_ack"));
		expect(fixture.server.isConnected("agent-1")).toBe(true);

		fixture.server.disconnect("agent-1");
		expect(fixture.server.isConnected("agent-1")).toBe(false);
		expect(fixture.connections.map((entry) => entry.connected)).toEqual([true, false]);
		// A request to a child the parent stopped tracking cannot reach it any more.
		await expect(fixture.server.request("agent-1", "get_state")).rejects.toMatchObject({
			code: "child_not_connected",
		});
		// Ending an unknown child is harmless.
		expect(() => fixture.server.disconnect("agent-1")).not.toThrow();
	});
});
