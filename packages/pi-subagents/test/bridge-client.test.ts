import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChildBridgeClient, type ChildBridgeRequest } from "../src/bridge-client.js";
import { ChildBridgeServer } from "../src/bridge-server.js";
import { type ChildIdentity, PROTOCOL_VERSION } from "../src/domain.js";
import {
	BridgeError,
	type HelloFrame,
	isChildInputPayload,
	isHelloFrame,
} from "../src/protocol.js";

interface Fixture {
	readonly endpoint: string;
	readonly server: ChildBridgeServer;
	readonly events: Array<{ childId: string; event: unknown }>;
	readonly requests: ChildBridgeRequest[];
	readonly connected: boolean[];
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const step of cleanup.splice(0)) await step();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-bridge-client-"));
	cleanup.push(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	return dir;
}

/**
 * The parent end the client dials. It only accepts the child role, so a client that connects at
 * all has proven the whole handshake.
 */
async function startParent(
	endpoint: string,
	handleRequest: (request: ChildBridgeRequest) => Promise<unknown> = async () => ({ ok: true }),
): Promise<Fixture> {
	const events: Fixture["events"] = [];
	const requests: Fixture["requests"] = [];
	const connected: boolean[] = [];
	const server = new ChildBridgeServer({
		endpoint,
		parentSessionId: "parent-1",
		authorize: (frame) => (frame.role === "child" ? undefined : "expected the child role"),
		handleRequest: async (request) => {
			requests.push(request);
			return await handleRequest(request);
		},
		diagnose: () => {},
	});
	server.onEvent((childId, event) => events.push({ childId, event }));
	server.onConnectionChange((_childId, isConnected) => connected.push(isConnected));
	await server.listen();
	cleanup.push(async () => {
		await server.close();
	});
	return { endpoint, server, events, requests, connected };
}

function identityFor(endpoint: string): ChildIdentity {
	return {
		parentSessionId: "parent-1",
		subagentId: "agent-1",
		runtimeIdentity: "runtime-1",
		endpoint,
		token: "token-1",
	};
}

function startChild(
	endpoint: string,
	options: {
		handleRequest?: (request: ChildBridgeRequest) => Promise<unknown>;
		maxBufferedReports?: number;
		reportTimeoutMs?: number;
		diagnose?: (message: string) => void;
	} = {},
): ChildBridgeClient {
	const client = new ChildBridgeClient({
		endpoint,
		identity: identityFor(endpoint),
		handleRequest: options.handleRequest ?? (async () => ({ ok: true })),
		reconnectDelayMs: 25,
		diagnose: options.diagnose ?? (() => {}),
		...(options.reportTimeoutMs === undefined ? {} : { reportTimeoutMs: options.reportTimeoutMs }),
		...(options.maxBufferedReports === undefined
			? {}
			: { maxBufferedReports: options.maxBufferedReports }),
	});
	client.start();
	cleanup.push(async () => {
		client.close();
	});
	return client;
}

async function waitForConnected(server: ChildBridgeServer, childId = "agent-1"): Promise<void> {
	await vi.waitFor(() => {
		expect(server.isConnected(childId)).toBe(true);
	});
}

describe("ChildBridgeClient", () => {
	test("connects to the parent and serves its requests", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const parent = await startParent(endpoint);
		const diagnoses: string[] = [];
		const child = startChild(endpoint, {
			diagnose: (message) => diagnoses.push(message),
			handleRequest: async (request) =>
				request.operation === "get_state" ? { idle: true, pendingMessages: 0 } : { ok: true },
		});
		await waitForConnected(parent.server);

		await expect(parent.server.request("agent-1", "get_state")).resolves.toEqual({
			idle: true,
			pendingMessages: 0,
		});
		expect(child.connected).toBe(true);
		expect(diagnoses).toEqual([]);
	});

	test("turns a rejected request into a coded failure response", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const parent = await startParent(endpoint);
		startChild(endpoint, {
			handleRequest: async (request) => {
				if (request.operation === "abort") {
					throw new BridgeError("not_streaming", "nothing to abort");
				}
				throw new Error("handler exploded");
			},
		});
		await waitForConnected(parent.server);

		await expect(parent.server.request("agent-1", "abort")).rejects.toMatchObject({
			code: "not_streaming",
		});
		await expect(parent.server.request("agent-1", "prompt")).rejects.toMatchObject({
			code: "bridge_error",
		});
	});

	test("keeps dialing while the parent is away", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const child = startChild(endpoint);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(child.connected).toBe(false);

		const parent = await startParent(endpoint);
		await waitForConnected(parent.server);
		expect(child.connected).toBe(true);
	});

	test("forwards events the child sends", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const parent = await startParent(endpoint);
		const child = startChild(endpoint);
		await waitForConnected(parent.server);

		child.sendEvent({ type: "agent_start" });
		child.sendEvent({ type: "agent_settled" });
		await vi.waitFor(() => {
			expect(parent.events.map((entry) => entry.event)).toEqual([
				{ type: "agent_start" },
				{ type: "agent_settled" },
			]);
		});
		expect(parent.events[0]?.childId).toBe("agent-1");
	});

	test("reports input with its source and nothing else", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const parent = await startParent(endpoint);
		const child = startChild(endpoint);
		await waitForConnected(parent.server);

		child.sendChildInput("interactive");
		await vi.waitFor(() => {
			expect(parent.events).toHaveLength(1);
		});
		const event = parent.events[0]?.event;
		expect(isChildInputPayload(event)).toBe(true);
		expect(event).toEqual({
			type: "child_input",
			parentSessionId: "parent-1",
			childId: "agent-1",
			runtimeIdentity: "runtime-1",
			source: "interactive",
		});
	});

	test("delivers a report and waits for the parent's answer", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const parent = await startParent(endpoint, async (request) =>
			request.operation === "contact_parent" ? { delivered: true } : { refused: true },
		);
		const child = startChild(endpoint);
		await waitForConnected(parent.server);

		await expect(
			child.sendReport("contact_parent", { type: "pi_subagent_report", message: "progress" }),
		).resolves.toEqual({ delivered: true });
		expect(parent.requests.map((entry) => entry.operation)).toEqual(["contact_parent"]);
	});

	test("gives up on a report whose caller was cancelled", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const parent = await startParent(endpoint);
		const child = startChild(endpoint);
		await waitForConnected(parent.server);

		const controller = new AbortController();
		const pending = child.sendReport("contact_parent", { message: "progress" }, controller.signal);
		controller.abort();

		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		// The tool call that carried it is gone, so the report must not be delivered later.
		expect(parent.requests).toEqual([]);
	});

	test("drops an advisory frame that cannot be encoded and keeps the connection", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const parent = await startParent(endpoint);
		const child = startChild(endpoint);
		await waitForConnected(parent.server);

		// An event too large for a frame says nothing about the socket: tearing the connection down
		// over it would cut a child off from its parent because one tool result was oversized.
		child.sendEvent({ type: "agent_end", message: { content: "x".repeat(2 * 1024 * 1024) } });

		await expect(child.sendReport("contact_parent", { message: "progress" })).resolves.toEqual({
			ok: true,
		});
		expect(parent.requests.map((entry) => entry.operation)).toEqual(["contact_parent"]);
		// The parent never saw the child drop and dial again, which is what a teardown would look like.
		expect(parent.connected).toEqual([true]);
	});

	test("fails a report the parent refuses", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const parent = await startParent(endpoint, async () => {
			throw new BridgeError("duplicate_task_result", "a result was already submitted");
		});
		const child = startChild(endpoint);
		await waitForConnected(parent.server);

		await expect(child.sendReport("task_result", { json: "{}" })).rejects.toMatchObject({
			code: "duplicate_task_result",
		});
	});

	test("buffers reports while the parent is unreachable and flushes them in order", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const child = startChild(endpoint);
		const first = child.sendReport("contact_parent", { message: "first" });
		const second = child.sendReport("contact_parent", { message: "second" });

		const parent = await startParent(endpoint);
		await waitForConnected(parent.server);
		await expect(first).resolves.toEqual({ ok: true });
		await expect(second).resolves.toEqual({ ok: true });
		await vi.waitFor(() => {
			expect(parent.requests.map((entry) => entry.payload)).toEqual([
				{ message: "first" },
				{ message: "second" },
			]);
		});
	});

	test("drops the oldest buffered report when the buffer is full", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const child = startChild(endpoint, { maxBufferedReports: 2 });
		const dropped = child.sendReport("contact_parent", { message: "oldest" });
		const kept = child.sendReport("contact_parent", { message: "middle" });
		const newest = child.sendReport("contact_parent", { message: "newest" });

		await expect(dropped).rejects.toMatchObject({ code: "report_buffer_full" });
		const parent = await startParent(endpoint);
		await waitForConnected(parent.server);
		await expect(kept).resolves.toEqual({ ok: true });
		await expect(newest).resolves.toEqual({ ok: true });
		await vi.waitFor(() => {
			expect(parent.requests.map((entry) => entry.payload)).toEqual([
				{ message: "middle" },
				{ message: "newest" },
			]);
		});
	});

	test("reconnects to a restarted parent and delivers what was buffered", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const first = await startParent(endpoint);
		const child = startChild(endpoint);
		await waitForConnected(first.server);

		await first.server.close();
		await vi.waitFor(() => {
			expect(child.connected).toBe(false);
		});
		const buffered = child.sendReport("contact_parent", { message: "after restart" });

		const restarted = await startParent(endpoint);
		await waitForConnected(restarted.server);
		await expect(buffered).resolves.toEqual({ ok: true });
		expect(restarted.requests.map((entry) => entry.payload)).toEqual([
			{ message: "after restart" },
		]);
		expect(restarted.connected).toEqual([true]);
	});

	test("fails what is still waiting when the child closes the bridge", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const child = startChild(endpoint);
		const buffered = child.sendReport("contact_parent", { message: "never sent" });
		child.close();

		await expect(buffered).rejects.toMatchObject({ code: "bridge_closed" });
		await expect(child.sendReport("contact_parent", { message: "later" })).rejects.toMatchObject({
			code: "bridge_closed",
		});
		expect(child.connected).toBe(false);
	});
});

describe("bridge protocol additions", () => {
	test("accepts the child role in a hello frame", () => {
		const hello: HelloFrame = {
			version: PROTOCOL_VERSION,
			type: "hello",
			role: "child",
			parentSessionId: "parent-1",
			subagentId: "agent-1",
			runtimeIdentity: "runtime-1",
			endpoint: "/tmp/parent.sock",
			token: "token-1",
		};
		expect(isHelloFrame(hello)).toBe(true);
		expect(isHelloFrame({ ...hello, role: "narrator" })).toBe(false);
	});

	test("accepts a child_input payload only in its documented shape", () => {
		const payload = {
			type: "child_input",
			parentSessionId: "parent-1",
			childId: "agent-1",
			runtimeIdentity: "runtime-1",
			source: "extension",
		};
		expect(isChildInputPayload(payload)).toBe(true);
		expect(isChildInputPayload({ ...payload, text: "hello" })).toBe(false);
		expect(isChildInputPayload({ ...payload, source: "typing" })).toBe(false);
	});
	test("delivers an in-flight report exactly once when the connection drops", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const answering = false;
		const first = await startParent(endpoint, async () => {
			// Hold the first attempt open so the report is in flight when the parent goes away.
			while (!answering) await new Promise((resolve) => setTimeout(resolve, 5));
			return { ok: true };
		});
		const child = startChild(endpoint);
		await waitForConnected(first.server);
		const report = child.sendReport("contact_parent", { message: "once" });
		await vi.waitFor(() => {
			expect(first.requests.length).toBe(1);
		});

		await first.server.close();
		await vi.waitFor(() => {
			expect(child.connected).toBe(false);
		});
		const restarted = await startParent(endpoint);
		await waitForConnected(restarted.server);
		await expect(report).resolves.toEqual({ ok: true });
		await vi.waitFor(() => {
			expect(restarted.requests.length).toBe(1);
		});
		// The retry is the same report, not a second copy of it.
		expect(restarted.requests.map((entry) => entry.payload)).toEqual([{ message: "once" }]);
	});

	test("keeps delivering queued reports after the parent refuses one", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const parent = await startParent(endpoint, async (request) => {
			if ((request.payload as { message?: string }).message === "refused") {
				throw new BridgeError("delivery_failed", "the parent refused this report");
			}
			return { ok: true };
		});
		const child = startChild(endpoint);
		await waitForConnected(parent.server);

		const refused = child.sendReport("contact_parent", { message: "refused" });
		const accepted = child.sendReport("contact_parent", { message: "after" });
		await expect(refused).rejects.toMatchObject({ code: "delivery_failed" });
		// A refused report concerns itself: the one behind it is still owed to the parent.
		await expect(accepted).resolves.toEqual({ ok: true });
		await vi.waitFor(() => {
			expect(parent.requests.map((entry) => entry.payload)).toEqual([
				{ message: "refused" },
				{ message: "after" },
			]);
		});
	});
	test("fails a report the parent never answers instead of holding the queue", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const parent = await startParent(endpoint, async (request) => {
			if ((request.payload as { message?: string }).message === "ignored") {
				return await new Promise((resolve) => setTimeout(resolve, 5_000));
			}
			return { ok: true };
		});
		const child = startChild(endpoint, { reportTimeoutMs: 40 });
		await waitForConnected(parent.server);

		const ignored = child.sendReport("contact_parent", { message: "ignored" });
		await expect(ignored).rejects.toMatchObject({ code: "timeout" });
		// The report behind it is still owed to the parent: one unanswered request does not freeze the
		// whole channel.
		await expect(child.sendReport("contact_parent", { message: "later" })).resolves.toEqual({
			ok: true,
		});
		expect(child.connected).toBe(true);
	});

	test("fails an unserializable report without dropping the connection", async () => {
		const endpoint = join(await tempDir(), "parent.sock");
		const parent = await startParent(endpoint);
		const child = startChild(endpoint);
		await waitForConnected(parent.server);

		await expect(
			child.sendReport("contact_parent", { message: "big", size: 1n }),
		).rejects.toMatchObject({ code: "unserializable_frame" });
		// Serialization is not a transport problem, so the channel is untouched.
		expect(child.connected).toBe(true);
		await expect(child.sendReport("contact_parent", { message: "fine" })).resolves.toEqual({
			ok: true,
		});
		expect(parent.requests.map((entry) => entry.payload)).toEqual([{ message: "fine" }]);
	});
});
