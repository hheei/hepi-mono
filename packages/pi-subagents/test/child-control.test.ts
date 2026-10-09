import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChildBridgeServer } from "../src/bridge-server.js";
import {
	type ChildControl,
	childInputSource,
	registerChildControl,
	sanitizeEventForBridge,
} from "../src/child-control.js";
import type { ChildIdentity } from "../src/domain.js";
import { isChildInputPayload } from "../src/protocol.js";
import { FORWARDED_PI_EVENT_TYPES } from "../src/rpc-events.js";

type AnyHandler = (event: unknown, context: unknown) => unknown;

interface FakePi {
	readonly api: ExtensionAPI;
	readonly sendUserMessage: ReturnType<typeof vi.fn>;
	emit(type: string, event: unknown, context: unknown): void;
	registered(): string[];
}

interface FakeContext {
	readonly context: ExtensionContext;
	readonly abort: ReturnType<typeof vi.fn>;
	readonly shutdown: ReturnType<typeof vi.fn>;
}

interface Parent {
	readonly server: ChildBridgeServer;
	readonly events: unknown[];
	readonly requests: Array<{ operation: string; payload: unknown }>;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const step of cleanup.splice(0)) await step();
});

function fakePi(): FakePi {
	const handlers = new Map<string, AnyHandler[]>();
	const sendUserMessage = vi.fn();
	const api = {
		on: (type: string, handler: AnyHandler) => {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
			return () => {
				handlers.set(
					type,
					(handlers.get(type) ?? []).filter((entry) => entry !== handler),
				);
			};
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;
	return {
		api,
		sendUserMessage,
		emit: (type, event, context) => {
			for (const handler of [...(handlers.get(type) ?? [])]) void handler(event, context);
		},
		registered: () => [...handlers.keys()],
	};
}

function fakeContext(
	options: { idle?: boolean; pending?: boolean; entries?: unknown[] } = {},
): FakeContext {
	const abort = vi.fn();
	const shutdown = vi.fn();
	return {
		abort,
		shutdown,
		context: {
			isIdle: () => options.idle ?? true,
			hasPendingMessages: () => options.pending ?? false,
			abort,
			shutdown,
			sessionManager: {
				getSessionId: () => "child-session",
				getSessionFile: () => "/tmp/child-session.jsonl",
				getEntries: () => options.entries ?? [],
			},
		} as unknown as ExtensionContext,
	};
}

async function startParent(): Promise<Parent> {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-child-control-"));
	cleanup.push(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const endpoint = join(dir, "parent.sock");
	const events: unknown[] = [];
	const requests: Parent["requests"] = [];
	const server = new ChildBridgeServer({
		endpoint,
		parentSessionId: "parent-1",
		authorize: (frame) => (frame.role === "child" ? undefined : "expected the child role"),
		handleRequest: async (request) => {
			requests.push({ operation: request.operation, payload: request.payload });
			return { ok: true };
		},
		diagnose: () => {},
	});
	server.onEvent((_childId, event) => events.push(event));
	await server.listen();
	cleanup.push(async () => {
		await server.close();
	});
	return { server, events, requests };
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

async function startChild(
	parent: Parent,
	options: { isActive?: () => boolean; api?: FakePi } = {},
): Promise<{
	pi: FakePi;
	control: ChildControl;
	endpoint: string;
	context: FakeContext;
}> {
	const endpoint = parent.server.endpoint;
	const pi = options.api ?? fakePi();
	const context = fakeContext();
	const control = registerChildControl(pi.api, {
		endpoint,
		identity: identityFor(endpoint),
		diagnose: () => {},
		...(options.isActive === undefined ? {} : { isActive: options.isActive }),
	});
	cleanup.push(async () => {
		control.dispose();
	});
	pi.emit("session_start", { type: "session_start", reason: "startup" }, context.context);
	control.start(context.context);
	await vi.waitFor(() => {
		expect(parent.server.isConnected("agent-1")).toBe(true);
	});
	return { pi, control, endpoint, context };
}

describe("registerChildControl", () => {
	test("answers get_state from the child's own Pi state", async () => {
		const parent = await startParent();
		const pi = fakePi();
		const context = fakeContext({ idle: false, pending: true });
		const control = registerChildControl(pi.api, {
			endpoint: parent.server.endpoint,
			identity: identityFor(parent.server.endpoint),
			diagnose: () => {},
		});
		cleanup.push(async () => {
			control.dispose();
		});
		pi.emit("session_start", { type: "session_start", reason: "startup" }, context.context);
		control.start(context.context);
		await vi.waitFor(() => {
			expect(parent.server.isConnected("agent-1")).toBe(true);
		});

		await expect(parent.server.request("agent-1", "get_state")).resolves.toEqual({
			idle: false,
			pendingMessages: true,
			sessionId: "child-session",
			sessionPath: "/tmp/child-session.jsonl",
		});
	});

	test("hands prompts, steers and follow-ups to the child's Pi", async () => {
		const parent = await startParent();
		const { pi } = await startChild(parent);

		await expect(
			parent.server.request("agent-1", "prompt", { message: "start the task" }),
		).resolves.toEqual({ accepted: true });
		await expect(
			parent.server.request("agent-1", "steer", { message: "go faster" }),
		).resolves.toEqual({ accepted: true });
		await expect(
			parent.server.request("agent-1", "follow_up", { message: "continue" }),
		).resolves.toEqual({ accepted: true });

		expect(pi.sendUserMessage.mock.calls).toEqual([
			["start the task"],
			["go faster", { deliverAs: "steer" }],
			["continue", { deliverAs: "followUp" }],
		]);
	});

	test("refuses a prompt without a message", async () => {
		const parent = await startParent();
		await startChild(parent);

		await expect(
			parent.server.request("agent-1", "prompt", { message: "   " }),
		).rejects.toMatchObject({ code: "invalid_payload" });
	});

	test("refuses everything before a Pi session exists", async () => {
		const parent = await startParent();
		const pi = fakePi();
		const control = registerChildControl(pi.api, {
			endpoint: parent.server.endpoint,
			identity: identityFor(parent.server.endpoint),
			diagnose: () => {},
		});
		cleanup.push(async () => {
			control.dispose();
		});
		// The bridge can be up before Pi hands this process a session; a request must still fail
		// visibly instead of being answered from a context that does not exist yet.
		control.start();
		await vi.waitFor(() => {
			expect(parent.server.isConnected("agent-1")).toBe(true);
		});

		await expect(parent.server.request("agent-1", "get_state")).rejects.toMatchObject({
			code: "session_not_ready",
		});
		await expect(parent.server.request("agent-1", "abort")).rejects.toMatchObject({
			code: "session_not_ready",
		});
	});

	test("implements abort and shutdown with the child's own primitives", async () => {
		const parent = await startParent();
		const { context } = await startChild(parent);

		await expect(parent.server.request("agent-1", "abort")).resolves.toEqual({ accepted: true });
		await expect(parent.server.request("agent-1", "shutdown")).resolves.toEqual({ accepted: true });
		expect(context.abort).toHaveBeenCalledTimes(1);
		expect(context.shutdown).toHaveBeenCalledTimes(1);
	});

	test("refuses an operation that belongs to the retired control plane", async () => {
		const parent = await startParent();
		await startChild(parent);

		await expect(parent.server.request("agent-1", "close_writer")).rejects.toMatchObject({
			code: "unsupported_operation",
		});
	});

	test("reads the child's session entries on request", async () => {
		const parent = await startParent();
		const entries = [{ type: "message", id: "entry-1" }];
		const pi = fakePi();
		const context = fakeContext({ entries });
		const control = registerChildControl(pi.api, {
			endpoint: parent.server.endpoint,
			identity: identityFor(parent.server.endpoint),
			diagnose: () => {},
		});
		cleanup.push(async () => {
			control.dispose();
		});
		pi.emit("session_start", { type: "session_start", reason: "startup" }, context.context);
		control.start(context.context);
		await vi.waitFor(() => {
			expect(parent.server.isConnected("agent-1")).toBe(true);
		});

		await expect(parent.server.request("agent-1", "get_entries")).resolves.toEqual({ entries });
	});

	test("forwards exactly the allowed Pi events", async () => {
		const parent = await startParent();
		const { pi } = await startChild(parent);

		for (const type of FORWARDED_PI_EVENT_TYPES) {
			pi.emit(type, { type }, {});
		}
		await vi.waitFor(() => {
			expect(parent.events).toHaveLength(FORWARDED_PI_EVENT_TYPES.length);
		});
		expect(parent.events).toEqual(FORWARDED_PI_EVENT_TYPES.map((type) => ({ type })));
		expect(pi.registered()).toContain("input");
		expect(pi.registered()).not.toContain("session_info_changed");
	});

	test("reports input by source and ignores an unknown one", async () => {
		const parent = await startParent();
		const { pi } = await startChild(parent);

		pi.emit("input", { type: "input", text: "hello", source: "interactive" }, {});
		pi.emit("input", { type: "input", text: "?", source: "telepathy" }, {});
		await vi.waitFor(() => {
			expect(parent.events).toHaveLength(1);
		});
		expect(parent.events[0]).toEqual({
			type: "child_input",
			parentSessionId: "parent-1",
			childId: "agent-1",
			runtimeIdentity: "runtime-1",
			source: "interactive",
		});
		expect(isChildInputPayload(parent.events[0])).toBe(true);
		expect(childInputSource({ source: "telepathy" })).toBeUndefined();
	});

	test("stays silent while the process serves another session", async () => {
		const parent = await startParent();
		const { pi, context } = await startChild(parent, { isActive: () => false });

		pi.emit("agent_start", { type: "agent_start" }, context.context);
		pi.emit("input", { type: "input", text: "hello", source: "interactive" }, context.context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(parent.events).toEqual([]);
	});

	test("closes the bridge when the child control is disposed", async () => {
		const parent = await startParent();
		const { pi, control, context } = await startChild(parent);

		control.dispose();
		pi.emit("agent_start", { type: "agent_start" }, context.context);
		await vi.waitFor(() => {
			expect(parent.server.isConnected("agent-1")).toBe(false);
		});
		expect(parent.events).toEqual([]);
	});
	test("refuses control requests once the process serves another session", async () => {
		const parent = await startParent();
		let active = true;
		const started = await startChild(parent, { isActive: () => active });
		await expect(parent.server.request("agent-1", "get_state")).resolves.toMatchObject({
			sessionId: "child-session",
		});

		// The human switched this TUI to a session the parent never launched, so the process is no
		// longer this child's runtime: driving it would act on that other session.
		active = false;
		await expect(parent.server.request("agent-1", "get_state")).rejects.toMatchObject({
			code: "inactive_session",
		});
		await expect(
			parent.server.request("agent-1", "prompt", { message: "keep going" }),
		).rejects.toMatchObject({ code: "inactive_session" });
		expect(started.pi.sendUserMessage).not.toHaveBeenCalled();
	});
	test("refuses input while the process has no session to put it in", async () => {
		const parent = await startParent();
		const started = await startChild(parent);

		// The bridge stays up while Pi switches sessions, but there is nowhere for a message to land.
		started.pi.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, undefined);
		await expect(
			parent.server.request("agent-1", "prompt", { message: "start now" }),
		).rejects.toMatchObject({ code: "session_not_ready" });
		expect(started.pi.sendUserMessage).not.toHaveBeenCalled();
	});

	test("sanitizeEventForBridge truncates large tool outputs and omits base64 image data", () => {
		const largeText = "a".repeat(5000);
		const rawEvent = {
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "call-1",
			result: {
				content: [
					{ type: "text", text: largeText },
					{ type: "image", mimeType: "image/png", data: "massive-base64-data" },
				],
			},
		};

		const sanitized = sanitizeEventForBridge(rawEvent) as typeof rawEvent;
		expect(sanitized.type).toBe("tool_execution_end");
		const textBlock = sanitized.result.content[0] as { type: string; text: string };
		expect(textBlock.text.length).toBeLessThan(1500);
		expect(textBlock.text).toContain("[truncated for bridge event]");

		const imageBlock = sanitized.result.content[1] as { type: string; data: string };
		expect(imageBlock.data).toBe("[image omitted for bridge event]");
	});

	test("sanitizeEventForBridge truncates large text content in message_update", () => {
		const largeText = "b".repeat(5000);
		const rawEvent = {
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "text", text: largeText }],
			},
		};

		const sanitized = sanitizeEventForBridge(rawEvent) as typeof rawEvent;
		expect(sanitized.type).toBe("message_update");
		const textBlock = sanitized.message.content[0] as { type: string; text: string };
		expect(textBlock.text.length).toBeLessThan(300);
		expect(textBlock.text).toContain("[truncated for bridge event]");
	});

	test("throttles streaming message_update deltas within the same phase", async () => {
		const parent = await startParent();
		const { pi } = await startChild(parent);

		// Multiple thinking deltas in a row: only the first should be forwarded
		pi.emit(
			"message_update",
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta" },
				message: { role: "assistant", content: [] },
			},
			{},
		);
		pi.emit(
			"message_update",
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta" },
				message: { role: "assistant", content: [] },
			},
			{},
		);

		// Switch to text delta: should be forwarded once
		pi.emit(
			"message_update",
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta" },
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			},
			{},
		);
		pi.emit(
			"message_update",
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta" },
				message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
			},
			{},
		);

		await vi.waitFor(() => {
			expect(parent.events).toHaveLength(2);
		});
		expect(
			(parent.events[0] as { assistantMessageEvent: { type: string } }).assistantMessageEvent.type,
		).toBe("thinking_delta");
		expect(
			(parent.events[1] as { assistantMessageEvent: { type: string } }).assistantMessageEvent.type,
		).toBe("text_delta");
	});

	test("sanitizeEventForBridge reduces a streaming update to compact phase telemetry", () => {
		const huge = "x".repeat(2 * 1024 * 1024);
		const rawEvent = {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: huge,
				content: huge,
				partial: { role: "assistant", content: [{ type: "text", text: huge }] },
			},
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: huge },
					{ type: "toolCall", name: "read", arguments: { path: huge } },
				],
			},
		};

		const sanitized = sanitizeEventForBridge(rawEvent) as {
			assistantMessageEvent: Record<string, unknown>;
			message: { content: Array<Record<string, unknown>> };
		};
		expect(sanitized.assistantMessageEvent).toEqual({ type: "toolcall_delta", contentIndex: 0 });
		expect(JSON.stringify(sanitized.assistantMessageEvent).length).toBeLessThan(200);
		expect(sanitized.assistantMessageEvent.partial).toBeUndefined();
		const toolCall = sanitized.message.content[1] as { name?: string; arguments?: unknown };
		expect(toolCall.name).toBe("read");
		expect(toolCall.arguments).toBeUndefined();
		expect(JSON.stringify(sanitized).length).toBeLessThan(4096);
	});

	test("sanitizeEventForBridge drops bulky tool arguments and bounds agent_end", () => {
		const started = sanitizeEventForBridge({
			type: "tool_execution_start",
			toolName: "write",
			toolCallId: "call-1",
			args: { content: "x".repeat(1024 * 1024) },
		});
		expect(started).toEqual({
			type: "tool_execution_start",
			toolName: "write",
			toolCallId: "call-1",
		});

		const settled = sanitizeEventForBridge({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "y".repeat(5000) }],
					stopReason: "stop",
				},
			],
		}) as { messages: Array<{ content: Array<{ text: string }> }> };
		expect(settled.messages).toHaveLength(1);
		expect(settled.messages[0]?.content[0]?.text.length).toBeLessThan(300);
	});

	test("resends the current phase after the bridge reconnects", async () => {
		const parent = await startParent();
		const { pi } = await startChild(parent);
		const thinkingDelta = {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta" },
			message: { role: "assistant", content: [] },
		};

		pi.emit("message_update", thinkingDelta, {});
		await vi.waitFor(() => {
			expect(parent.events).toHaveLength(1);
		});

		// The parent goes away and comes back; it must learn the phase it missed.
		parent.server.disconnect("agent-1");
		await vi.waitFor(
			() => {
				expect(parent.server.isConnected("agent-1")).toBe(true);
			},
			{ timeout: 5_000 },
		);
		await vi.waitFor(
			() => {
				expect(parent.events).toHaveLength(2);
			},
			{ timeout: 5_000 },
		);
		expect(
			(parent.events[1] as { assistantMessageEvent: { type: string } }).assistantMessageEvent.type,
		).toBe("thinking_delta");

		// A repeated delta in the same phase is still dropped while the parent is listening.
		pi.emit("message_update", thinkingDelta, {});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(parent.events).toHaveLength(2);
	}, 10_000);

	test("get_entries prefers active branch entries over all raw tree entries", async () => {
		const parent = await startParent();
		const rawEntries = [
			{ type: "message", id: "entry-1" },
			{ type: "message", id: "old-branch" },
		];
		const activeBranchEntries = [
			{ type: "message", id: "entry-1" },
			{ type: "message", id: "active-branch" },
		];
		const pi = fakePi();
		const context = fakeContext({ entries: rawEntries });
		(context.context.sessionManager as { getBranch?: () => unknown[] }).getBranch = () =>
			activeBranchEntries;
		const control = registerChildControl(pi.api, {
			endpoint: parent.server.endpoint,
			identity: identityFor(parent.server.endpoint),
			diagnose: () => {},
		});
		cleanup.push(async () => {
			control.dispose();
		});
		pi.emit("session_start", { type: "session_start", reason: "startup" }, context.context);
		control.start(context.context);
		await vi.waitFor(() => {
			expect(parent.server.isConnected("agent-1")).toBe(true);
		});

		await expect(parent.server.request("agent-1", "get_entries")).resolves.toEqual({
			entries: activeBranchEntries,
		});
	});
});
