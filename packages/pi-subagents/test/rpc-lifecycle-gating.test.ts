/**
 * rpc-lifecycle-gating.test.ts — issue #142.
 *
 * pi runs every extension factory BEFORE applying an agent's `extensions:`
 * filter, and only delivers lifecycle events (session_start, …) to the
 * survivors — but the `pi.events` bus is shared with the filtered-out
 * activations. The old code registered the RPC handlers and emitted
 * `subagents:ready` at factory time, so a child session that excluded
 * pi-subagents still saw `subagents:ready` + a working `subagents:rpc:ping`,
 * yet every spawn failed with "No active session" (its session_start never
 * fired, so currentCtx stayed undefined).
 *
 * The fix defers BOTH the RPC registration and the readiness broadcast to the
 * first bound session_start. These tests drive the real extension factory with
 * a mock ExtensionAPI and assert the timing: nothing is wired at factory time;
 * everything is wired (once) on session_start.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import subagentsExtension from "../src/index.js";

const RPC_CHANNELS = ["subagents:rpc:ping", "subagents:rpc:spawn", "subagents:rpc:stop"] as const;
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

type LifecycleHandler = (event: unknown, context: unknown) => unknown | Promise<unknown>;
type RpcHandler = (raw: unknown) => unknown | Promise<unknown>;
type MockCalls = { readonly mock: { readonly calls: readonly unknown[][] } };

function makePi() {
	const tools = new Map<string, { readonly name: string }>();
	const lifecycle = new Map<string, LifecycleHandler[]>(); // pi.on(...) — session_start, session_shutdown, …
	const busHandlers = new Map<string, RpcHandler>(); // pi.events.on(...) — rpc channels
	const emit = vi.fn();
	const eventOn = vi.fn((event: string, handler: RpcHandler) => {
		busHandlers.set(event, handler);
		return vi.fn();
	});
	const pi = {
		registerMessageRenderer: vi.fn(),
		registerTool: vi.fn((tool: { readonly name: string }) => tools.set(tool.name, tool)),
		registerCommand: vi.fn(),
		on: vi.fn((event: string, handler: LifecycleHandler) => {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		}),
		events: {
			emit,
			on: eventOn,
		},
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	return { pi, tools, lifecycle, busHandlers, emit, eventOn };
}

function ctx() {
	return {
		hasUI: false,
		ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
		cwd: process.cwd(),
		model: undefined,
		modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
		sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
		getSystemPrompt: vi.fn(() => "parent"),
	} as unknown as ExtensionContext;
}

async function emitLifecycle(
	lifecycle: Map<string, LifecycleHandler[]>,
	event: string,
): Promise<void> {
	for (const handler of lifecycle.get(event) ?? []) await handler({}, ctx());
}

const readyEmits = (emit: MockCalls): readonly unknown[][] =>
	emit.mock.calls.filter((call) => call[0] === "subagents:ready");
const onCallsFor = (eventOn: MockCalls, channel: string): readonly unknown[][] =>
	eventOn.mock.calls.filter((call) => call[0] === channel);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("issue #142: RPC handlers + subagents:ready are gated on session_start", () => {
	let tmpDir: string;
	let agentDir: string;
	let prevCwd: string;
	let prevAgentDir: string | undefined;
	let prevHome: string | undefined;

	beforeEach(() => {
		// Hermetic cwd + global dir with scheduling off, so session_start doesn't
		// spin a scheduler or touch the dev's filesystem — isolates the RPC wiring.
		tmpDir = mkdtempSync(join(tmpdir(), "pi-142-"));
		agentDir = mkdtempSync(join(tmpdir(), "pi-142-agentdir-"));
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		prevHome = process.env.HOME;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.HOME = agentDir;
		prevCwd = process.cwd();
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ "pi-subagents": { runtime: { schedulingEnabled: false } } }),
		);
		process.chdir(tmpDir);
	});

	afterEach(() => {
		// Each host has its own pi.events bus. Reset process-global ownership between
		// tests; different hosts are not child activations of one live root.
		delete (globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY];
		process.chdir(prevCwd);
		if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		if (prevHome == null) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(tmpDir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("does NOT advertise or register RPC at factory time (the filtered-out case)", () => {
		const { pi, busHandlers, emit } = makePi();

		// A filtered-out activation only ever gets the factory run — its
		// session_start never fires. So after the factory alone, nothing should
		// be on the shared bus.
		subagentsExtension(pi);

		expect(readyEmits(emit), "no subagents:ready before session_start").toHaveLength(0);
		for (const channel of RPC_CHANNELS) {
			expect(busHandlers.has(channel), `${channel} must not be registered at factory time`).toBe(
				false,
			);
		}
	});

	it("advertises and registers RPC on session_start, and spawn works once bound", async () => {
		const { pi, lifecycle, busHandlers, emit } = makePi();
		subagentsExtension(pi);

		await emitLifecycle(lifecycle, "session_start");

		// Readiness broadcast once, all three channels now live.
		expect(readyEmits(emit), "subagents:ready fires once bound").toHaveLength(1);
		for (const channel of RPC_CHANNELS) {
			expect(busHandlers.has(channel), `${channel} registered on session_start`).toBe(true);
		}

		// spawn no longer hits the "No active session" trap — currentCtx is set.
		const requestId = "req-142";
		const spawnHandler = busHandlers.get("subagents:rpc:spawn");
		if (spawnHandler === undefined) throw new Error("Missing spawn RPC handler");
		await spawnHandler({
			requestId,
			type: "general-purpose",
			prompt: "go",
			options: { description: "rpc gating test" },
		});

		const reply = emit.mock.calls.find(
			(call) => call[0] === `subagents:rpc:spawn:reply:${requestId}`,
		);
		if (reply === undefined) throw new Error("Spawn RPC did not emit a reply");
		const payload = reply[1];
		if (!isRecord(payload) || !isRecord(payload.data))
			throw new Error(`Invalid spawn RPC reply: ${JSON.stringify(payload)}`);
		expect(payload.success, `spawn succeeded, got: ${JSON.stringify(payload)}`).toBe(true);
		expect(payload.data.id).toBeTruthy();
	});

	it("is idempotent — a second session_start does not re-advertise or double-register", async () => {
		const { pi, lifecycle, emit, eventOn } = makePi();
		subagentsExtension(pi);

		await emitLifecycle(lifecycle, "session_start");
		await emitLifecycle(lifecycle, "session_start");

		expect(
			readyEmits(emit),
			"subagents:ready emitted exactly once across two session_starts",
		).toHaveLength(1);
		for (const channel of RPC_CHANNELS) {
			expect(onCallsFor(eventOn, channel), `${channel} registered exactly once`).toHaveLength(1);
		}
	});
});
