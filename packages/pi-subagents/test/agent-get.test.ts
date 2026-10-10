import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import type { PublicSubagent } from "../src/domain.js";
import type { SubagentManager } from "../src/manager.js";
import { registerParentTools } from "../src/tools.js";

function createFakePi() {
	const registeredTools: ToolDefinition[] = [];
	const pi = {
		registerTool(tool: ToolDefinition) {
			registeredTools.push(tool);
		},
		getAllTools() {
			return registeredTools;
		},
		getActiveTools() {
			return registeredTools.map((t) => t.name);
		},
		setActiveTools() {},
		on() {
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return { pi, registeredTools };
}

const mockChild: PublicSubagent = {
	id: "agent-9",
	path: "/mock/sessions/child-session-9.jsonl",
	agent: "scout",
	displayName: "Code Scout",
	state: "done",
	presentation: "panel",
	cwd: "/mock/repo",
	sessionId: "session-9",
	task: "Investigate performance bottleneck",
	summary: "Found hot loop in query tokenizer",
	freshness: "live",
	model: { provider: "mock", id: "m1", source: "agent" },
	thinking: { level: "low", source: "agent" },
	createdAt: "2026-10-05T00:00:00Z",
	updatedAt: "2026-10-05T00:01:00Z",
	usage: {
		inputTokens: 1200,
		outputTokens: 300,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.01,
		turns: 2,
	},
};

const context = { cwd: process.cwd() } as unknown as ExtensionToolContext;

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
	const [only] = result.content;
	return only?.type === "text" ? (only.text ?? "") : "";
}

describe("agent_get tool", () => {
	test("registers the four agent tools and no list tool", () => {
		const { pi, registeredTools } = createFakePi();
		registerParentTools(pi, {} as unknown as SubagentManager, []);
		expect(registeredTools.map((tool) => tool.name)).toEqual([
			"agent_spawn",
			"agent_send",
			"agent_get",
			"agent_stop",
		]);
	});

	test("declares readOnlyHint and idempotentHint annotations for agent_get", () => {
		const { pi, registeredTools } = createFakePi();
		registerParentTools(pi, {} as unknown as SubagentManager, []);
		const getTool = registeredTools.find((t) => t.name === "agent_get");
		expect(getTool?.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
	});

	test("defaults to status and progress without leaking task or terminal result", async () => {
		const { pi, registeredTools } = createFakePi();
		const manager = { get: vi.fn(async () => mockChild) } as unknown as SubagentManager;
		registerParentTools(pi, manager, []);
		const getTool = registeredTools.find((t) => t.name === "agent_get")!;

		const result = await getTool.execute(
			"call_get",
			{ id: "agent-9" },
			undefined,
			undefined,
			context,
		);
		const text = textOf(result);

		expect(JSON.parse(text)).toEqual(result.details);
		expect(result.details).toEqual({
			status: "done",
			progress: {
				agent: "scout",
				path: mockChild.path,
				presentation: "panel",
				freshness: "live",
				turns: 2,
				tokens: 1500,
			},
		});
		expect(JSON.stringify(result)).not.toContain(mockChild.task);
		expect(JSON.stringify(result)).not.toContain(mockChild.summary);
		expect(text).not.toContain("do not poll");
	});

	test("keys select diagnostic fields and unknown keys fail", async () => {
		const { pi, registeredTools } = createFakePi();
		const manager = {
			get: vi.fn(async () => ({
				...mockChild,
				state: "blocked",
				interrupted: "Parent decision required",
			})),
		} as unknown as SubagentManager;
		registerParentTools(pi, manager, []);
		const getTool = registeredTools.find((t) => t.name === "agent_get")!;

		const result = await getTool.execute(
			"call_get",
			{ id: "agent-9", keys: "status, diagnostic" },
			undefined,
			undefined,
			context,
		);
		const text = textOf(result);

		expect(JSON.parse(text)).toEqual({ status: "blocked", diagnostic: "Parent decision required" });
		expect(result.details).toEqual({ status: "blocked", diagnostic: "Parent decision required" });

		await expect(
			getTool.execute("call_get", { id: "agent-9", keys: "bogus" }, undefined, undefined, context),
		).rejects.toThrow(/Unknown agent_get key "bogus"/);
	});

	test("second successful inspection adds the no-poll reminder", async () => {
		const { pi, registeredTools } = createFakePi();
		const manager = { get: vi.fn(async () => mockChild) } as unknown as SubagentManager;
		registerParentTools(pi, manager, []);
		const getTool = registeredTools.find((t) => t.name === "agent_get")!;
		const inspect = () => getTool.execute("call", { id: "agent-9" }, undefined, undefined, context);

		const first = await inspect();
		const second = await inspect();
		expect(textOf(first)).not.toContain("do not poll");
		expect(textOf(second)).toContain("Results are returned automatically; do not poll agent_get.");
		expect(second.details).toEqual(first.details);
	});

	test("agent_stop stops the child runtime by id", async () => {
		const { pi, registeredTools } = createFakePi();
		const stop = vi.fn(async () => mockChild);
		const manager = { stop } as unknown as SubagentManager;
		registerParentTools(pi, manager, []);
		const stopTool = registeredTools.find((t) => t.name === "agent_stop")!;

		const result = await stopTool.execute(
			"call_stop",
			{ id: "agent-9" },
			undefined,
			undefined,
			context,
		);
		expect(textOf(result)).toBe("Agent stopped.");
		expect(result.details).toBeUndefined();
		expect(stop).toHaveBeenCalledWith("agent-9");
	});
});

test("agent_spawn rejects caller IDs; agent_send reuses existing ID", async () => {
	const { pi, registeredTools } = createFakePi();
	const spawn = vi.fn(async () => ({
		child: mockChild,
		path: mockChild.path,
		note: "No presentation host available",
	}));
	const send = vi.fn(async () => mockChild);
	registerParentTools(pi, { spawn, send } as unknown as SubagentManager, []);
	const spawnTool = registeredTools.find((tool) => tool.name === "agent_spawn")!;
	const sendTool = registeredTools.find((tool) => tool.name === "agent_send")!;
	expect(spawnTool.parameters).toMatchObject({ additionalProperties: false });
	await expect(
		spawnTool.execute(
			"call",
			{ agent: "scout", task: "inspect", id: "agent-9" },
			undefined,
			undefined,
			context,
		),
	).rejects.toThrow("Invalid agent_spawn parameters");
	expect(spawn).not.toHaveBeenCalled();
	const spawned = await spawnTool.execute(
		"call",
		{ agent: "scout", task: "inspect" },
		undefined,
		undefined,
		context,
	);
	expect(JSON.parse(textOf(spawned))).toEqual({ id: "agent-9", path: mockChild.path });
	expect(spawned.details).toEqual({ id: "agent-9", path: mockChild.path });
	expect(spawn).toHaveBeenCalledWith({ agent: "scout", task: "inspect" });
	const sent = await sendTool.execute(
		"call",
		{ id: "agent-9", message: "continue" },
		undefined,
		undefined,
		context,
	);
	expect(textOf(sent)).toBe("Message sent.");
	expect(sent.details).toBeUndefined();
	expect(send).toHaveBeenCalledWith("agent-9", "continue", undefined, undefined);
});

test.each([
	"agent_spawn",
	"agent_send",
	"agent_get",
	"agent_stop",
])("%s failures return only the reason", async (name) => {
	const { pi, registeredTools } = createFakePi();
	const failure = vi.fn(async () => ({
		operation: name,
		childId: "agent-9",
		reason: "Runtime could not be reached",
		state: "error",
		sideEffects: ["private runtime metadata"],
		safeToRetry: false,
	}));
	registerParentTools(
		pi,
		{ spawn: failure, send: failure, get: failure, stop: failure } as unknown as SubagentManager,
		[],
	);
	const tool = registeredTools.find((tool) => tool.name === name)!;
	const params =
		name === "agent_spawn"
			? { agent: "scout", task: "inspect" }
			: { id: "agent-9", message: "continue" };
	await expect(tool.execute("call", params, undefined, undefined, context)).rejects.toThrow(
		/^Runtime could not be reached$/,
	);
});

test("agent_get bounds active progress and diagnostics; omits successful final answer", async () => {
	const { pi, registeredTools } = createFakePi();
	let child: PublicSubagent = { ...mockChild, state: "running", summary: "x".repeat(3000) };
	registerParentTools(pi, { get: vi.fn(async () => child) } as unknown as SubagentManager, []);
	const getTool = registeredTools.find((tool) => tool.name === "agent_get")!;
	const get = (keys: string) =>
		getTool.execute("call", { id: "agent-9", keys }, undefined, undefined, context);
	expect((await get("progress")).details).toMatchObject({
		progress: { summary: "x".repeat(2000) },
	});
	child = { ...mockChild, state: "error", interrupted: "e".repeat(3000) };
	expect((await get("diagnostic")).details).toEqual({ diagnostic: "e".repeat(2000) });
	child = mockChild;
	expect((await get("diagnostic")).details).toEqual({});
});
