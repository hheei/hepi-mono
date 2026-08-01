import type {
	ConversationReplyResult,
	ConversationSubagentHandle,
	ExtensionLifecycleContext,
	SubagentEvent,
} from "@hheei/pi-ext-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startSubagent = vi.hoisted(() => vi.fn());

vi.mock("@hheei/pi-ext-core", async () => {
	const actual = await vi.importActual<typeof import("@hheei/pi-ext-core")>("@hheei/pi-ext-core");
	return { ...actual, startSubagent };
});

vi.mock("../src/worktree.js", () => ({
	cleanupWorktree: vi.fn(),
	createWorktree: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

interface FakeHandle {
	handle: ConversationSubagentHandle;
	emit: (event: SubagentEvent) => void;
	steer: ReturnType<typeof vi.fn>;
	cancel: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
}

function fakeHandle(): FakeHandle {
	let observer: ((event: SubagentEvent) => void | Promise<void>) | undefined;
	const steer = vi.fn(async () => undefined);
	const cancel = vi.fn();
	const send = vi.fn(
		async () =>
			({
				id: "subagent-1",
				sequence: 2,
				status: "completed",
				output: "resumed",
				softLimitReached: false,
			}) as unknown as ConversationReplyResult,
	);
	const initialReply = Promise.resolve({
		id: "subagent-1",
		sequence: 1,
		status: "completed",
		output: "done",
		softLimitReached: false,
	} as unknown as ConversationReplyResult);
	const handle = {
		id: "subagent-1",
		mode: "conversation",
		status: "running",
		initialReply,
		result: Promise.resolve({ id: "subagent-1", mode: "conversation", status: "completed" }),
		compact: vi.fn(async () => undefined),
		usage: vi.fn(() => ({ input: 1, output: 2, total: 3, cost: 0 })),
		transcript: vi.fn(() => ({ id: "subagent-1", entries: [], truncated: false })),
		steer,
		cancel,
		send,
		subscribe: vi.fn((options: { onEvent: (event: SubagentEvent) => void | Promise<void> }) => {
			observer = options.onEvent;
			return { dispose: vi.fn() };
		}),
	} as unknown as ConversationSubagentHandle;
	return {
		handle,
		emit: (event) => void observer?.(event),
		steer,
		cancel,
		send,
	};
}

function runtime(): ExtensionLifecycleContext {
	return {
		pi: {} as ExtensionLifecycleContext["pi"],
		extension: {} as ExtensionLifecycleContext["extension"],
		signal: new AbortController().signal,
		resources: { add: vi.fn() } as unknown as ExtensionLifecycleContext["resources"],
	};
}

describe("AgentManager core adapter", () => {
	let manager: AgentManager;

	beforeEach(() => {
		startSubagent.mockReset();
	});

	afterEach(() => {
		manager?.dispose();
	});

	it("routes child creation through the opaque core conversation handle", async () => {
		const fake = fakeHandle();
		startSubagent.mockReturnValue(fake.handle);
		manager = new AgentManager();
		manager.setRuntime(runtime());

		const id = manager.spawn(
			{} as never,
			{ cwd: "/tmp", getSystemPrompt: () => "parent" } as never,
			"general-purpose",
			"inspect",
			{
				description: "Inspect files",
				maxTurns: 12,
				isBackground: true,
			},
		);
		const record = manager.getRecord(id);

		expect(record?.handle).toBe(fake.handle);
		expect(startSubagent).toHaveBeenCalledOnce();
		expect(startSubagent.mock.calls[0]?.[1]).toMatchObject({
			mode: "conversation",
			initialMessage: "inspect",
			maxTurnsPerReply: 12,
		});
		await expect(record?.promise).resolves.toBe("done");
		expect(record?.status).toBe("completed");
	});

	it("marks records started only when core admits their turn", () => {
		const fake = fakeHandle();
		startSubagent.mockReturnValue(fake.handle);
		const onStart = vi.fn();
		manager = new AgentManager(undefined, 2, onStart);
		manager.setRuntime(runtime());
		const id = manager.spawn(
			{} as never,
			{ cwd: "/tmp", getSystemPrompt: () => "parent" } as never,
			"general-purpose",
			"inspect",
			{ description: "Inspect files" },
		);

		expect(manager.getRecord(id)?.status).toBe("queued");
		expect(onStart).not.toHaveBeenCalled();
		fake.emit({ kind: "turn", id: id as never, state: "running" });
		expect(manager.getRecord(id)?.status).toBe("running");
		expect(onStart).toHaveBeenCalledOnce();
	});

	it("forwards core events into extension-owned activity callbacks", () => {
		const fake = fakeHandle();
		startSubagent.mockReturnValue(fake.handle);
		manager = new AgentManager();
		manager.setRuntime(runtime());
		const text = vi.fn();
		const tool = vi.fn();
		const id = manager.spawn(
			{} as never,
			{ cwd: "/tmp", getSystemPrompt: () => "parent" } as never,
			"general-purpose",
			"inspect",
			{
				description: "Inspect files",
				onTextDelta: text,
				onToolActivity: tool,
			},
		);

		fake.emit({ kind: "text", id: id as never, text: "hello" });
		fake.emit({ kind: "tool", id: id as never, toolName: "read", state: "end" });

		expect(text).toHaveBeenCalledWith("hello", "hello");
		expect(tool).toHaveBeenCalledWith({ type: "end", toolName: "read" });
	});

	it("cancels the core conversation when the parent signal aborts", () => {
		const fake = fakeHandle();
		startSubagent.mockReturnValue(fake.handle);
		manager = new AgentManager();
		manager.setRuntime(runtime());
		const controller = new AbortController();
		manager.spawn(
			{} as never,
			{ cwd: "/tmp", getSystemPrompt: () => "parent" } as never,
			"general-purpose",
			"inspect",
			{
				description: "Inspect files",
				signal: controller.signal,
			},
		);

		controller.abort("parent stopped");

		expect(fake.cancel).toHaveBeenCalledOnce();
	});

	it("uses the core conversation handle for resume and steer", async () => {
		const fake = fakeHandle();
		startSubagent.mockReturnValue(fake.handle);
		manager = new AgentManager();
		manager.setRuntime(runtime());
		const id = manager.spawn(
			{} as never,
			{ cwd: "/tmp", getSystemPrompt: () => "parent" } as never,
			"general-purpose",
			"inspect",
			{
				description: "Inspect files",
			},
		);

		await manager.getRecord(id)?.promise;
		expect(manager.steer(id, "focus on tests")).toBe(true);
		await expect(manager.resume(id, "continue")).resolves.toMatchObject({ result: "resumed" });
		expect(manager.getRecord(id)).toMatchObject({ status: "completed", error: undefined });
		expect(fake.steer).toHaveBeenCalledWith("focus on tests");
		expect(fake.send).toHaveBeenCalledWith(
			"continue",
			expect.objectContaining({ inputMode: "queue" }),
		);
	});

	it("reports completion through the extension callback without exposing a session", async () => {
		const fake = fakeHandle();
		startSubagent.mockReturnValue(fake.handle);
		let completed: AgentRecord | undefined;
		manager = new AgentManager((record) => {
			completed = record;
		});
		manager.setRuntime(runtime());
		const id = manager.spawn(
			{} as never,
			{ cwd: "/tmp", getSystemPrompt: () => "parent" } as never,
			"general-purpose",
			"inspect",
			{
				description: "Inspect files",
			},
		);

		await manager.getRecord(id)?.promise;

		expect(completed?.handle).toBe(fake.handle);
		expect(completed && "session" in completed).toBe(false);
	});
});
