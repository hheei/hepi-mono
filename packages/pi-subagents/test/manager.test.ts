import { join } from "node:path";
import { TaskRegistry } from "@hheei/pi-ext-core";
import { describe, expect, test, vi } from "vitest";
import type { EffectiveLaunchConfig, SpawnSubagentInput, SubagentRecord } from "../src/domain.js";
import type { HostAttachment, HostObservation } from "../src/host-adapter.js";
import { assembleChildPrompt } from "../src/launch-spec.js";
import {
	type ChildBridgeTransport,
	extractLastAssistantText,
	type ParentChannelReport,
	SubagentManager,
} from "../src/manager.js";
import { BridgeError, type BridgeOperation } from "../src/protocol.js";
import { createSubagentRegistry } from "../src/registry.js";
import type { LaunchOutcome, RuntimeTokenStore } from "../src/runtime.js";

const PARENT_SESSION_ID = "01J7-parent";

interface FakeRuntime {
	readonly pid: number;
	alive: boolean;
	readonly exited: Promise<number | null>;
	terminate(graceMs?: number): Promise<void>;
	terminated: number;
	/** Makes the next terminate() leave the process running, as a kill it did not win would. */
	refuseToDie: boolean;
	/** Ends the process outside terminate(), as a crash or a self-exit would. */
	exit(code: number): void;
}

/** The panel this parent opened for a child, with the two answers the manager acts on. */
class FakeAttachment implements HostAttachment {
	readonly identity = {
		host: "herdr",
		attachmentId: "wG:tH",
		createdBy: PARENT_SESSION_ID,
	} as const;
	readonly launch = { stdout: "", stderr: "", exitCode: 0, timedOut: false };
	readonly reportsFocus: boolean;
	public alive = true;
	public focused: boolean | undefined = false;
	/** Makes cleanup() fail and leave the panel standing, as a refusing host would. */
	public refuseToClose = false;
	/** Makes observation time out, which is not the same answer as "the panel is gone". */
	public unknown = false;
	public cleanups = 0;

	public constructor(reportsFocus: boolean) {
		this.reportsFocus = reportsFocus;
	}

	public async observe(): Promise<HostObservation> {
		return {
			identity: this.identity,
			alive: this.unknown ? false : this.alive,
			known: !this.unknown,
			...(this.focused === undefined ? {} : { focused: this.focused }),
			detail: "",
		};
	}

	public async cleanup(): Promise<HostAttachment["launch"]> {
		this.cleanups += 1;
		if (this.refuseToClose) {
			return { stdout: "", stderr: "close denied", exitCode: 1, timedOut: false };
		}
		this.alive = false;
		return this.launch;
	}
}

interface Harness {
	readonly manager: SubagentManager;
	readonly bridge: FakeBridge;
	readonly launch: ReturnType<typeof vi.fn>;
	readonly openPanel: ReturnType<typeof vi.fn>;
	/** The background process handles this harness's launches created, by child id. */
	readonly runtimes: Map<string, FakeRuntime>;
	readonly panels: Map<string, FakeAttachment>;
	readonly connect: ReturnType<typeof vi.fn>;
	readonly tokens: RuntimeTokenStore;
	readonly reports: ParentChannelReport[];
	readonly registry: ReturnType<typeof createSubagentRegistry>;
	readonly cwd: string;
	addChild(id: string, overrides?: Partial<SubagentRecord>): SubagentRecord;
}

class FakeBridge implements ChildBridgeTransport {
	readonly connected = new Set<string>();
	readonly requests: Array<{ childId: string; operation: string; payload: unknown }> = [];
	#events = new Set<(childId: string, event: unknown) => void>();
	#connections = new Set<(childId: string, connected: boolean) => void>();
	public responses = new Map<string, () => Promise<unknown>>();
	public fallbackResponse: (childId: string, operation: BridgeOperation) => Promise<unknown> =
		async () => undefined;

	public isConnected(childId: string): boolean {
		return this.connected.has(childId);
	}

	public async request(
		childId: string,
		operation: BridgeOperation,
		payload?: unknown,
	): Promise<unknown> {
		this.requests.push({ childId, operation, payload });
		if (!this.connected.has(childId)) {
			throw new BridgeError("child_not_connected", `Child ${childId} is not connected`);
		}
		const responder = this.responses.get(`${childId}:${operation}`);
		return responder === undefined
			? await this.fallbackResponse(childId, operation)
			: await responder();
	}

	public onEvent(listener: (childId: string, event: unknown) => void): () => void {
		this.#events.add(listener);
		return () => {
			this.#events.delete(listener);
		};
	}

	public onConnectionChange(listener: (childId: string, connected: boolean) => void): () => void {
		this.#connections.add(listener);
		return () => {
			this.#connections.delete(listener);
		};
	}

	public connect(childId: string): void {
		this.connected.add(childId);
		for (const listener of [...this.#connections]) listener(childId, true);
	}

	public disconnect(childId: string): void {
		this.connected.delete(childId);
		for (const listener of [...this.#connections]) listener(childId, false);
	}

	public emit(childId: string, event: unknown): void {
		for (const listener of [...this.#events]) listener(childId, event);
	}

	/** Waits until the child's per-transition chain has applied everything queued so far. */
	public async settle(): Promise<void> {
		for (let index = 0; index < 20; index++) await Promise.resolve();
	}
}

function launchConfig(subagentId: string, cwd: string): EffectiveLaunchConfig {
	return {
		subagentId,
		invocation: { command: process.execPath, args: ["-e", "process.stdin.resume()"] },
		cwd,
		sessionId: `${subagentId}-session`,
		sessionDir: join(cwd, "sessions"),
		agent: {
			name: "worker",
			hidden: false,
			sourcePath: join(cwd, "worker.md"),
			instructions: "Do the work.",
		},
		model: { provider: "anthropic", id: "claude-sonnet-4", source: "parent" },
		thinking: { level: "medium", source: "parent" },
		tools: ["contact_parent"],
		excludeTools: [],
		extensions: { discovery: false, paths: ["/pkg/dist/extension.js"] },
		skills: { discovery: true, paths: [] },
		prompt: assembleChildPrompt("Do the work."),
		bridgeExtensionPath: "/pkg/dist/extension.js",
		interactive: false,
	};
}

async function harness(
	options: {
		idleTimeoutMs?: number;
		deadlineMs?: number;
		failedPanelCloseTimeoutMs?: number;
		/** Set when this parent has a presentation host and spawns into panels by default. */
		host?: boolean;
		/** Set when the host cannot report focus, which is how cmux behaves today. */
		blindHost?: boolean;
	} = {},
): Promise<Harness> {
	const cwd = process.cwd();
	const path = join(await withTempDirPath(), "registry.json");
	const registry = createSubagentRegistry({ parentSessionId: PARENT_SESSION_ID, filePath: path });
	const bridge = new FakeBridge();
	bridge.fallbackResponse = async (id, operation) => {
		if (operation === "get_entries") return { entries: [] };
		if (operation !== "get_state") return undefined;
		const record = await registry.get(id);
		return {
			idle: record?.state !== "running",
			pendingMessages: false,
		};
	};
	const tokens: RuntimeTokenStore = {
		remember: vi.fn(),
		get: vi.fn(() => undefined),
		forget: vi.fn(),
	};
	const reports: ParentChannelReport[] = [];
	let sequence = 0;
	const runtimes = new Map<string, FakeRuntime>();
	const panels = new Map<string, FakeAttachment>();
	/** Whatever starts a child's runtime also records it and lets the bridge connect, as Pi does. */
	const startRuntime = async (record: SubagentRecord): Promise<FakeRuntime> => {
		let exit: (code: number) => void = () => {};
		const runtime: FakeRuntime = {
			pid: 1000 + sequence,
			alive: true,
			// A real process exits on its own schedule, so the exit promise is resolved explicitly.
			exited: new Promise<number>((resolve) => {
				exit = resolve;
			}),
			terminated: 0,
			refuseToDie: false,
			async terminate(): Promise<void> {
				runtime.terminated += 1;
				if (runtime.refuseToDie) return;
				runtime.alive = false;
				bridge.connect(record.subagentId);
				bridge.disconnect(record.subagentId);
				exit(0);
			},
			exit,
		};
		runtimes.set(record.subagentId, runtime);
		// The real launcher records which runtime it started before the child connects.
		await registry.update(record.subagentId, undefined, (current) => ({
			...current,
			runtime: { runtimeIdentity: `runtime-${sequence}`, endpoint: "/tmp/parent.sock" },
		}));
		bridge.connect(record.subagentId);
		return runtime;
	};
	const launch = vi.fn(async (record: SubagentRecord): Promise<LaunchOutcome<FakeRuntime>> => {
		return { handle: await startRuntime(record) };
	});
	const openPanel = vi.fn(
		async (record: SubagentRecord): Promise<LaunchOutcome<FakeAttachment>> => {
			await startRuntime(record);
			const attachment = new FakeAttachment(options.blindHost !== true);
			panels.set(record.subagentId, attachment);
			return { handle: attachment };
		},
	);
	const connect = vi.fn(async (record: SubagentRecord) => bridge.isConnected(record.subagentId));
	const recordFactory = (id: string, overrides: Partial<SubagentRecord> = {}): SubagentRecord => {
		const config = launchConfig(id, cwd);
		return {
			subagentId: id,
			parentSessionId: PARENT_SESSION_ID,
			revision: 1,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			sessionId: config.sessionId,
			cwd,
			initialTask: "Do the work.",
			intent: "active",
			state: "running",
			presentation: "background",
			persistence: "never_flushed",
			launchConfig: config,
			...overrides,
		};
	};
	const manager = new SubagentManager({
		parentSessionId: PARENT_SESSION_ID,
		registry,
		bridge,
		launch,
		connect,
		tokens,
		...(options.host === true
			? { presentation: { reason: "default host herdr is available", openPanel } }
			: {}),
		channel: {
			async deliver(report): Promise<void> {
				reports.push(report);
			},
		},
		deadlineMs: options.deadlineMs ?? 1_000,
		...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
		...(options.failedPanelCloseTimeoutMs === undefined
			? {}
			: { failedPanelCloseTimeoutMs: options.failedPanelCloseTimeoutMs }),
		async resolve(input: SpawnSubagentInput): Promise<EffectiveLaunchConfig> {
			sequence += 1;
			return launchConfig(`sa_child${sequence}`, input.cwd ?? cwd);
		},
		async bootstrap({ task, launchConfig: config, presentation }): Promise<SubagentRecord> {
			const record = recordFactory(config.subagentId, {
				state: "running",
				initialTask: task,
				launchConfig: config,
				presentation,
			});
			return await registry.create(record);
		},
	});
	return {
		manager,
		bridge,
		launch,
		openPanel,
		panels,
		runtimes,
		connect,
		tokens,
		reports,
		registry,
		cwd,
		async addChild(id: string, overrides: Partial<SubagentRecord> = {}): Promise<SubagentRecord> {
			return await registry.create(recordFactory(id, overrides));
		},
	} as unknown as Harness;
}

async function withTempDirPath(): Promise<string> {
	const { mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	return await mkdtemp(join(tmpdir(), "pi-subagents-manager-"));
}

describe("SubagentManager over the bridge", () => {
	test("spawns a child, delivers the task over the bridge, and reports it running", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);

		expect(spawned.child.state).toBe("running");
		expect(spawned.child.freshness).toBe("live");
		expect(test1.launch).toHaveBeenCalledTimes(1);
		// The bridge connection also triggers adoption reads; the task itself is one prompt.
		expect(test1.bridge.requests.filter((request) => request.operation === "prompt")).toEqual([
			{ childId: spawned.child.id, operation: "prompt", payload: { message: "Do the work." } },
		]);
	});

	test("persists an unconfirmed initial delivery as failed and not retryable", async () => {
		const test1 = await harness();
		test1.bridge.responses.set("sa_child1:prompt", async () => {
			// Lose the acknowledgement only after the started run has been projected, not while
			// its event is still queued (which would itself re-add the work count).
			const startedEvent = { type: "agent_start" };
			let observed = false;
			let resolveApplied = () => {};
			const applied = new Promise<void>((resolve) => {
				resolveApplied = resolve;
			});
			const stopEvents = test1.manager.onChildEvent((_id, event) => {
				if (event === startedEvent) observed = true;
			});
			const stopChange = test1.manager.onChange(() => {
				if (observed) resolveApplied();
			});
			test1.bridge.emit("sa_child1", startedEvent);
			await applied;
			stopEvents();
			stopChange();
			throw new BridgeError("timeout", "no answer");
		});
		test1.bridge.responses.set("sa_child1:get_state", async () => ({
			idle: false,
			pendingMessages: false,
		}));
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		expect(spawned).toMatchObject({
			operation: "spawn",
			reason: "no answer",
			state: "error",
			safeToRetry: false,
		});
		expect(await test1.manager.get("sa_child1")).toMatchObject({
			state: "error",
			freshness: "live",
		});
		expect(test1.manager.activeCount).toBe(1);
		test1.bridge.emit("sa_child1", { type: "agent_settled" });
		await vi.waitFor(() => expect(test1.manager.activeCount).toBe(0));
	});

	test("selects steer, follow_up and prompt from the child's real state", async () => {
		const test1 = await harness();
		await test1.addChild("sa_live", { state: "running" });
		test1.bridge.connect("sa_live");
		await test1.manager.send("sa_live", "more");
		expect(test1.bridge.requests.at(-1)).toMatchObject({ operation: "steer" });

		await test1.addChild("sa_idle", { state: "done" });
		test1.bridge.connect("sa_idle");
		await test1.manager.send("sa_idle", "more");
		expect(test1.bridge.requests.at(-1)).toMatchObject({ operation: "follow_up" });
	});

	test("resumes a child whose runtime is gone instead of asking a dead socket", async () => {
		const test1 = await harness();
		await test1.addChild("sa_gone", { state: "done" });
		const sent = await test1.manager.send("sa_gone", "keep going");
		if ("reason" in sent) throw new Error(sent.reason);

		expect(test1.launch).toHaveBeenCalledTimes(1);
		expect(test1.bridge.requests.at(-1)).toMatchObject({
			childId: "sa_gone",
			operation: "prompt",
			payload: { message: "keep going" },
		});
	});

	test("refuses unknown, stopped and Task children", async () => {
		const test1 = await harness();
		expect(await test1.manager.send("sa_nope", "x")).toMatchObject({ reason: "Unknown child" });
		await test1.addChild("sa_stop", { intent: "stopped", state: "error" });
		// A terminal refusal says so: the model must not retry a send that can never work.
		expect(await test1.manager.send("sa_stop", "x")).toMatchObject({
			reason: expect.stringMatching(/never resumes|error state/),
			safeToRetry: false,
		});
	});

	test("reports liveness only while the bridge connection is up", async () => {
		const test1 = await harness();
		await test1.addChild("sa_quiet", { state: "done" });
		expect(await test1.manager.get("sa_quiet")).toMatchObject({ freshness: "last_known" });
		expect(await test1.manager.list()).toEqual([
			expect.objectContaining({ id: "sa_quiet", freshness: "last_known" }),
		]);
		test1.bridge.connect("sa_quiet");
		expect(await test1.manager.get("sa_quiet")).toMatchObject({ freshness: "live" });
	});

	test("stops a child by writing the intent first and ending the process", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);

		const stopped = await test1.manager.stop(spawned.child.id);
		expect(stopped).toMatchObject({ id: spawned.child.id, state: "error" });
		const record = await test1.manager.get(spawned.child.id);
		expect(record).toMatchObject({ state: "error", freshness: "last_known" });
		// The runtime metadata goes with the process, so nothing is left that could hold the session.
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeUndefined();
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(true);
		// A stop is terminal even though the session survives it: the answer says so instead of
		// leaving the model to retry a send that can never work.
		await expect(test1.manager.send(spawned.child.id, "continue")).resolves.toMatchObject({
			operation: "send",
			reason: expect.stringMatching(/never resumes|error state/),
			safeToRetry: false,
		});
		expect(test1.launch).toHaveBeenCalledTimes(1);
	});

	test("refuses to call a stop confirmed while the process is still alive", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const runtime = test1.runtimes.get(spawned.child.id);
		if (runtime === undefined) throw new Error("no runtime was started");
		runtime.refuseToDie = true;

		expect(await test1.manager.stop(spawned.child.id)).toMatchObject({
			state: "error",
			reason: expect.stringContaining("not confirmed"),
		});
		// The evidence stays behind: a process that ignored the kill may still own the session.
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeDefined();
	});

	test("hibernates an idle child: shutdown over the bridge, then the process, then done", async () => {
		const test1 = await harness({ idleTimeoutMs: 10 });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await test1.manager.get(spawned.child.id);

		await vi.waitFor(async () => {
			expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "done" });
		});
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeUndefined();
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(true);
	});

	test("keeps an unconfirmed idle runtime and refuses to start a second one", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		// The panel refuses to close and still reports the child running: the exit is unconfirmed.
		attachment.refuseToClose = true;

		await vi.waitFor(async () => {
			expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "error" });
		});
		// The handle is kept, so the next send cannot start a second runtime for the same session.
		const sent = await test1.manager.send(spawned.child.id, "keep going");
		expect(sent).toMatchObject({ reason: expect.stringContaining("not confirmed gone") });
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
	});

	test("settles a background child whose process exits after its bridge dropped", async () => {
		const test1 = await harness();
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const runtime = test1.runtimes.get(spawned.child.id);
		if (runtime === undefined) throw new Error("no runtime was started");

		// A turn is in flight when the bridge goes away while the process is still running: nothing is
		// settled yet, because the process may reconnect.
		test1.bridge.emit(spawned.child.id, { type: "agent_start" });
		await test1.bridge.settle();
		test1.bridge.disconnect(spawned.child.id);
		await test1.bridge.settle();
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "running" });
		// The handle is still held, so nothing may start a second runtime for this session yet.
		expect(await test1.manager.send(spawned.child.id, "already?")).toMatchObject({
			reason: expect.stringContaining("not confirmed gone"),
		});
		expect(test1.launch).toHaveBeenCalledTimes(1);

		// The process ends afterwards, with no second connection event to carry the news.
		runtime.alive = false;
		runtime.exit(0);
		await vi.waitFor(async () => {
			expect(await test1.manager.get(spawned.child.id)).toMatchObject({
				state: "blocked",
				freshness: "last_known",
			});
		});
		// The handle goes with the process, so a later send starts a fresh runtime.
		expect(test1.runtimes.size).toBe(1);
		await expect(test1.manager.send(spawned.child.id, "again")).resolves.toMatchObject({
			id: spawned.child.id,
		});
		expect(test1.launch).toHaveBeenCalledTimes(2);
	});

	test("confirms unacknowledged input once the child's own transcript shows it", async () => {
		const test1 = await harness();
		await test1.addChild("sa_input", { state: "running", unacknowledgedInput: "keep going" });
		test1.bridge.connect("sa_input");
		test1.bridge.responses.set("sa_input:get_entries", async () => ({
			entries: [{ type: "message", message: { role: "user", content: "keep going" } }],
		}));
		test1.bridge.emit("sa_input", { type: "agent_end", messages: [] });
		await vi.waitFor(async () => {
			const record = await test1.manager.get("sa_input");
			expect(record).toMatchObject({ state: "running" });
			expect((await test1.registry.get("sa_input"))?.unacknowledgedInput).toBeUndefined();
		});
	});

	test("counts startup and post-agent_end work until the final settle", async () => {
		const current = await harness({ idleTimeoutMs: 10 });
		const spawned = await current.manager.spawn({ agent: "worker", task: "work" });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const id = spawned.child.id;
		expect(current.manager.activeCount).toBe(1);
		current.bridge.emit(id, { type: "agent_start" });
		current.bridge.emit(id, { type: "agent_end", messages: [] });
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(current.manager.activeCount).toBe(1);
		expect(await current.manager.get(id)).toMatchObject({ state: "running" });
		expect(current.bridge.requests.some((request) => request.operation === "shutdown")).toBe(false);
		current.bridge.emit(id, { type: "agent_settled" });
		await vi.waitFor(() => expect(current.manager.activeCount).toBe(0));
		current.manager.closeLocalConnections();
	});

	test("does not clear new work when an older settled event is still queued", async () => {
		const current = await harness();
		const spawned = await current.manager.spawn({ agent: "worker", task: "work" });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const counts: number[] = [];
		const unsubscribe = current.manager.onChange(() => counts.push(current.manager.activeCount));
		current.bridge.emit(spawned.child.id, { type: "agent_settled" });
		current.bridge.emit(spawned.child.id, { type: "agent_start" });
		await vi.waitFor(() => expect(counts.length).toBeGreaterThanOrEqual(3));
		expect(counts).not.toContain(0);
		expect(current.manager.activeCount).toBe(1);
		current.bridge.emit(spawned.child.id, { type: "agent_settled" });
		await vi.waitFor(() => expect(current.manager.activeCount).toBe(0));
		unsubscribe();
		current.manager.closeLocalConnections();
	});

	test("adopts actual work state even when transcript retrieval fails", async () => {
		const current = await harness();
		await current.addChild("sa_partial", { state: "running" });
		current.bridge.connected.add("sa_partial");
		current.bridge.responses.set("sa_partial:get_entries", async () => {
			throw new Error("entries unavailable");
		});
		current.bridge.responses.set("sa_partial:get_state", async () => ({
			idle: true,
			pendingMessages: false,
		}));
		expect(await current.manager.recover()).toMatchObject({
			recovered: ["sa_partial"],
			failures: [],
		});
		expect(current.manager.activeCount).toBe(0);
		expect(await current.manager.get("sa_partial")).toMatchObject({ state: "done" });
		current.manager.closeLocalConnections();
	});

	test("reports an unavailable adoption state and converges on a later reconnect", async () => {
		const current = await harness();
		await current.addChild("sa_unknown", { state: "running" });
		current.bridge.connected.add("sa_unknown");
		current.bridge.responses.set("sa_unknown:get_state", async () => {
			throw new Error("state unavailable");
		});
		expect(await current.manager.recover()).toMatchObject({
			recovered: [],
			failures: [{ childId: "sa_unknown", reason: "state unavailable" }],
		});
		expect(current.manager.activeCount).toBe(1);
		current.bridge.responses.set("sa_unknown:get_state", async () => ({
			idle: true,
			pendingMessages: false,
		}));
		current.bridge.connect("sa_unknown");
		await vi.waitFor(() => expect(current.manager.activeCount).toBe(0));
		current.manager.closeLocalConnections();
	});

	test("reports a user interrupt to the parent and keeps it visible", async () => {
		const test1 = await harness();
		await test1.addChild("sa_int", {
			state: "running",
			runtime: { runtimeIdentity: "runtime-1", endpoint: "/tmp/parent.sock" },
		});
		test1.bridge.connect("sa_int");
		test1.bridge.emit("sa_int", {
			type: "child_lifecycle",
			parentSessionId: PARENT_SESSION_ID,
			childId: "sa_int",
			runtimeIdentity: "runtime-1",
			kind: "user_interrupt",
			sessionId: "sa_int-session",
			message: "Task is unfinished and waiting for user intent.",
		});
		await vi.waitFor(() => {
			expect(test1.reports.map((report) => report.reason)).toEqual(["user_interrupt"]);
		});
		expect((await test1.registry.get("sa_int"))?.interrupted).toBe(
			"Task is unfinished and waiting for user intent.",
		);
	});

	test("ignores lifecycle notices that name another runtime", async () => {
		const test1 = await harness();
		await test1.addChild("sa_stale", {
			state: "running",
			runtime: { runtimeIdentity: "runtime-now", endpoint: "/tmp/parent.sock" },
		});
		test1.bridge.connect("sa_stale");
		test1.bridge.emit("sa_stale", {
			type: "child_lifecycle",
			parentSessionId: PARENT_SESSION_ID,
			childId: "sa_stale",
			runtimeIdentity: "runtime-old",
			kind: "user_interrupt",
			sessionId: "sa_stale-session",
		});
		await test1.bridge.settle();
		expect(test1.reports).toEqual([]);
	});

	test("delivers a report the child sends and refuses a stale or repeated one", async () => {
		const test1 = await harness();
		await test1.addChild("sa_report", {
			state: "running",
			runtime: { runtimeIdentity: "runtime-1", endpoint: "/tmp/parent.sock" },
		});
		await expect(
			test1.manager.handleChildRequest("sa_report", "contact_parent", {
				type: "pi_subagent_report",
				parentSessionId: PARENT_SESSION_ID,
				childId: "sa_report",
				runtimeIdentity: "runtime-1",
				reason: "blocked",
				message: "halfway",
			}),
		).resolves.toEqual({ delivered: true });
		expect(test1.reports).toHaveLength(1);

		await expect(
			test1.manager.handleChildRequest("sa_report", "contact_parent", {
				type: "pi_subagent_report",
				parentSessionId: PARENT_SESSION_ID,
				childId: "sa_report",
				runtimeIdentity: "runtime-old",
				reason: "blocked",
				message: "halfway",
			}),
		).rejects.toMatchObject({ code: "stale_report" });
	});

	test("refuses to resume a panel child whose runtime never reconnected after a restart", async () => {
		const test1 = await harness({ host: true });
		const record = await test1.addChild("sa_leftover", {
			state: "running",
			presentation: "panel",
			runtime: { runtimeIdentity: "runtime-before-restart", endpoint: "/tmp/parent.sock" },
		});

		// A panel child is held by the host, so it outlives the parent. Its bridge did not come back,
		// and nothing here can observe whether that process is still running.
		await expect(test1.manager.recover()).resolves.toMatchObject({ recovered: [] });
		await expect(test1.manager.send(record.subagentId, "continue")).resolves.toMatchObject({
			operation: "send",
			reason: expect.stringContaining("exit cannot be confirmed"),
			safeToRetry: false,
		});
		expect(test1.launch).not.toHaveBeenCalled();
		expect(test1.openPanel).not.toHaveBeenCalled();

		// The runtime shows itself: the doubt is gone and the child takes input again.
		test1.bridge.connect(record.subagentId);
		await test1.bridge.settle();
		await expect(test1.manager.send(record.subagentId, "continue")).resolves.toMatchObject({
			id: record.subagentId,
		});
		expect(
			test1.bridge.requests.some(
				(request) => request.childId === record.subagentId && request.operation === "steer",
			),
		).toBe(true);
	});

	test("keeps a stopped child stopped and says plainly that a new child is needed", async () => {
		const test1 = await harness({ host: true });
		const record = await test1.addChild("sa_leftover_stopped", {
			state: "running",
			presentation: "panel",
			runtime: { runtimeIdentity: "runtime-before-restart", endpoint: "/tmp/parent.sock" },
		});

		// Stopping the leftover is the documented way out of an unconfirmed runtime, and it is
		// terminal: the session survives, but the send after it must fail visibly and say that a new
		// child is what the model has to spawn.
		await expect(test1.manager.recover()).resolves.toMatchObject({ recovered: [] });
		await expect(test1.manager.stop(record.subagentId)).resolves.toMatchObject({
			id: record.subagentId,
			state: "error",
		});
		await expect(test1.manager.send(record.subagentId, "continue")).resolves.toMatchObject({
			operation: "send",
			reason: expect.stringMatching(/never resumes|error state/),
			safeToRetry: false,
		});
		expect(test1.launch).not.toHaveBeenCalled();
		expect(test1.openPanel).not.toHaveBeenCalled();
	});

	test("clears the runtime a background child had before the parent restarted", async () => {
		const test1 = await harness();
		const record = await test1.addChild("sa_bg", {
			state: "running",
			runtime: { runtimeIdentity: "runtime-before-restart", endpoint: "/tmp/parent.sock" },
		});

		// A background child is held by this process's stdin pipe, so it died with the parent: the
		// evidence is stale and the next send starts it again from the same session.
		await test1.manager.recover();
		const settled = await test1.registry.get(record.subagentId);
		expect(settled?.runtime).toBeUndefined();
		expect(settled?.state).toBe("done");
		expect(settled?.interrupted).toContain("ended with the parent process");

		await expect(test1.manager.send(record.subagentId, "continue")).resolves.toMatchObject({
			id: record.subagentId,
		});
		expect(test1.launch).toHaveBeenCalledTimes(1);
	});

	test("keeps a record idle when a state-less event follows an adoption", async () => {
		const test1 = await harness({ host: true });
		const record = await test1.addChild("sa_adopted", { state: "running" });
		test1.bridge.responses.set("sa_adopted:get_entries", async () => ({ entries: [] }));
		test1.bridge.responses.set("sa_adopted:get_state", async () => ({
			idle: true,
			pendingMessages: false,
		}));

		test1.bridge.connect(record.subagentId);
		await vi.waitFor(async () => {
			expect(await test1.manager.get(record.subagentId)).toMatchObject({ state: "done" });
		});

		// A tool event carries no state of its own, so it must not write the older projection back.
		// The record is written back asynchronously, so wait for that write instead of for a state
		// that was already there before the event.
		const originalUpdate = test1.registry.update.bind(test1.registry);
		const writes: Array<Promise<unknown>> = [];
		vi.spyOn(test1.registry, "update").mockImplementation((id, revision, updater) => {
			const result = originalUpdate(id, revision, updater);
			writes.push(result);
			return result;
		});
		test1.bridge.emit(record.subagentId, {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
		});
		await vi.waitFor(() => {
			expect(writes.length).toBeGreaterThan(0);
		});
		await Promise.all(writes);
		expect(await test1.manager.get(record.subagentId)).toMatchObject({ state: "done" });
	});

	test("refuses a request from an unknown child and an operation the parent does not serve", async () => {
		const test1 = await harness();
		await expect(
			test1.manager.handleChildRequest("sa_ghost", "contact_parent", {}),
		).rejects.toMatchObject({ code: "unknown_child" });
		await test1.addChild("sa_ops", { state: "done" });
		await expect(test1.manager.handleChildRequest("sa_ops", "prompt", {})).rejects.toMatchObject({
			code: "unsupported_operation",
		});
	});

	test("adopts a child that reconnects and notices a runtime that went away", async () => {
		const test1 = await harness();
		await test1.addChild("sa_adopt", { state: "running" });
		test1.bridge.responses.set("sa_adopt:get_entries", async () => ({ entries: [] }));
		test1.bridge.responses.set("sa_adopt:get_state", async () => ({
			idle: false,
			pendingMessages: false,
			sessionId: "sa_adopt-session",
		}));
		test1.bridge.connect("sa_adopt");
		await vi.waitFor(async () => {
			expect(await test1.manager.get("sa_adopt")).toMatchObject({
				state: "running",
				freshness: "live",
			});
		});

		test1.bridge.disconnect("sa_adopt");
		await vi.waitFor(async () => {
			const record = await test1.manager.get("sa_adopt");
			expect(record).toMatchObject({ state: "blocked", freshness: "last_known" });
			expect((await test1.registry.get("sa_adopt"))?.interrupted).toContain("runtime ended");
		});
	});

	test("adopts surviving children on recovery and never launches anything", async () => {
		const test1 = await harness();
		await test1.addChild("sa_alive", { state: "running" });
		await test1.addChild("sa_dead", { state: "running" });
		test1.bridge.connect("sa_alive");
		test1.bridge.responses.set("sa_alive:get_entries", async () => ({ entries: [] }));
		test1.bridge.responses.set("sa_alive:get_state", async () => ({
			idle: true,
			pendingMessages: false,
			sessionId: "sa_alive-session",
		}));

		const recovery = await test1.manager.recover();
		expect(recovery.recovered).toEqual(["sa_alive"]);
		// A child that does not reconnect is simply not running; that is not a recovery failure,
		// and nothing is launched on its behalf.
		expect(recovery.failures).toEqual([]);
		expect(test1.launch).not.toHaveBeenCalled();
		expect(await test1.manager.get("sa_alive")).toMatchObject({ state: "done" });
	});

	test("stops listening to the transport when it is disposed", async () => {
		const test1 = await harness();
		await test1.addChild("sa_dispose", { state: "running" });
		test1.manager.dispose();
		test1.bridge.connect("sa_dispose");
		await test1.bridge.settle();
		expect(await test1.manager.get("sa_dispose")).toMatchObject({ state: "running" });
	});
	/** Waits out one idle countdown plus slack, for the cases that assert a panel was left alone. */
	async function waitPastIdle(idleTimeoutMs: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, idleTimeoutMs * 4));
	}

	test("spawns into a panel when a host is available and says so when it is not", async () => {
		const withHost = await harness({ host: true });
		const panelChild = await withHost.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in panelChild) throw new Error(panelChild.reason);
		expect(panelChild.child.presentation).toBe("panel");
		expect(panelChild.note).toBeUndefined();
		expect(withHost.openPanel).toHaveBeenCalledTimes(1);
		expect(withHost.launch).not.toHaveBeenCalled();

		// No host: the same spawn runs headless, and the result says why instead of leaving the
		// caller to guess which presentation it got.
		const headless = await harness();
		const background = await headless.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in background) throw new Error(background.reason);
		expect(background.child.presentation).toBe("background");
		expect(background.note).toContain("runs in the background");
		expect(headless.launch).toHaveBeenCalledTimes(1);
	});

	test("runs a child in a panel when a host exists", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Do the work.",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		expect(spawned.child.presentation).toBe("panel");
		expect(spawned.note).toBeUndefined();
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
		expect(test1.launch).not.toHaveBeenCalled();
	});

	test("stops a panel child by closing its panel, not by killing a process it does not own", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		expect(test1.launch).not.toHaveBeenCalled();

		const stopped = await test1.manager.stop(spawned.child.id);
		expect(stopped).toMatchObject({
			id: spawned.child.id,
			state: "error",
			presentation: "panel",
		});
		expect(attachment.cleanups).toBe(1);
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(true);
		// The runtime evidence goes with the panel, so nothing is left that could hold the session.
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeUndefined();
	});

	test("refuses to call a panel stop confirmed while the panel is still there", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.refuseToClose = true;

		expect(await test1.manager.stop(spawned.child.id)).toMatchObject({
			state: "error",
			reason: expect.stringContaining("not confirmed gone"),
		});
		// The evidence stays behind: a panel the parent could not close may still run the child.
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeDefined();
		const requestsBeforeReconnect = test1.bridge.requests.length;
		test1.bridge.disconnect(spawned.child.id);
		test1.bridge.connect(spawned.child.id);
		// send drains the queued connection transitions before answering, so this checks the state
		// after reconnection handling rather than the stopped value that already existed.
		await expect(test1.manager.send(spawned.child.id, "continue")).resolves.toMatchObject({
			safeToRetry: false,
			reason: expect.stringMatching(/never resumes|error state/),
		});
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "error" });
		expect(test1.bridge.requests).toHaveLength(requestsBeforeReconnect);
	});

	test("treats an unobservable panel as unconfirmed rather than closed", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.unknown = true;

		expect(await test1.manager.stop(spawned.child.id)).toMatchObject({
			state: "error",
			reason: expect.stringContaining("not confirmed gone"),
		});
		expect((await test1.registry.get(spawned.child.id))?.runtime).toBeDefined();
	});

	test("retires a child that left its session: no control of the new one, and the panel is not closed", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		const record = await test1.registry.get(spawned.child.id);
		if (record?.runtime === undefined) throw new Error("no runtime was recorded");

		test1.bridge.emit(spawned.child.id, {
			type: "child_lifecycle",
			parentSessionId: PARENT_SESSION_ID,
			childId: spawned.child.id,
			runtimeIdentity: record.runtime.runtimeIdentity,
			kind: "left_session",
			sessionId: "another-session",
		});
		await vi.waitFor(async () => {
			expect((await test1.registry.get(spawned.child.id))?.runtime).toBeUndefined();
		});
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({
			state: "done",
			freshness: "last_known",
		});
		// The panel now belongs to the session the human switched to.
		expect(attachment.cleanups).toBe(0);
		expect(test1.tokens.forget).toHaveBeenCalledWith(record.runtime.runtimeIdentity);

		// A send starts a fresh runtime for the delegated session instead of typing into that session.
		const sent = await test1.manager.send(spawned.child.id, "keep going");
		if ("reason" in sent) throw new Error(sent.reason);
		expect(test1.openPanel).toHaveBeenCalledTimes(2);
		expect(test1.bridge.requests.at(-1)).toMatchObject({
			childId: spawned.child.id,
			operation: "prompt",
			payload: { message: "keep going" },
		});
	});

	test("idle reclaim leaves a focused panel alone, then closes it once nobody is watching", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.focused = true;
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await test1.bridge.settle();

		await waitPastIdle(10);
		expect(attachment.cleanups).toBe(0);
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "done" });

		attachment.focused = false;
		await vi.waitFor(async () => {
			expect(attachment.cleanups).toBeGreaterThan(0);
		});
		expect(attachment.cleanups).toBeGreaterThan(0);
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(true);
		// A disconnect arriving after idle reclaim is not a manual close. A later send still resumes
		// the same child and session rather than failing as stopped.
		test1.bridge.disconnect(spawned.child.id);
		await expect(test1.manager.send(spawned.child.id, "continue")).resolves.toMatchObject({
			id: spawned.child.id,
			state: "running",
		});
		expect(test1.openPanel).toHaveBeenCalledTimes(2);
		expect((await test1.registry.get(spawned.child.id))?.sessionId).toBe(spawned.child.sessionId);
	});

	test("idle observation of an already exited panel marks done without blocked and can be resumed", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.alive = false;
		attachment.focused = false;
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		// An idle panel whose process exits is not blocked: it marks done and remains active
		await vi.waitFor(async () => {
			expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "done" });
		});
		test1.bridge.disconnect(spawned.child.id);
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(false);
	});

	test("does not reclaim a panel that started being used while the check was in flight", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.focused = false;
		const realObserve = attachment.observe.bind(attachment);
		let entered: (() => void) | undefined;
		let release: (() => void) | undefined;
		const observing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		attachment.observe = async () => {
			// The answer is taken first, so what the host said cannot change while it is held.
			const answer = await realObserve();
			entered?.();
			await blocked;
			return answer;
		};
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await test1.bridge.settle();
		await observing;
		// Someone started using the panel while the host was answering. The event is queued behind
		// the reclaim, so only the count of inbound signals can stop a decision already in flight.
		test1.bridge.emit(spawned.child.id, {
			type: "child_input",
			parentSessionId: PARENT_SESSION_ID,
			childId: spawned.child.id,
			runtimeIdentity: "runtime-1",
			source: "interactive",
		});
		attachment.focused = true;
		release?.();
		await test1.bridge.settle();
		await waitPastIdle(20);

		expect(attachment.cleanups).toBe(0);
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(false);
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "done" });
	});

	test("never reclaims a panel whose host cannot report focus", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true, blindHost: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		test1.bridge.emit(spawned.child.id, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await test1.bridge.settle();

		await waitPastIdle(10);
		expect(attachment.cleanups).toBe(0);
		expect(await test1.manager.get(spawned.child.id)).toMatchObject({ state: "done" });
	});

	test("human input in the panel cancels the countdown but a parent message does not", async () => {
		const test1 = await harness({ idleTimeoutMs: 30, host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		const settled = {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		};
		const input = (source: string): unknown => ({
			type: "child_input",
			parentSessionId: PARENT_SESSION_ID,
			childId: spawned.child.id,
			runtimeIdentity: "runtime-1",
			source,
		});
		test1.bridge.emit(spawned.child.id, settled);
		test1.bridge.emit(spawned.child.id, input("interactive"));
		await test1.bridge.settle();
		await waitPastIdle(30);
		expect(attachment.cleanups).toBe(0);

		// A message the parent sent over the bridge says nothing about the panel, so the countdown
		// that follows the next finished turn still closes it.
		test1.bridge.emit(spawned.child.id, settled);
		test1.bridge.emit(spawned.child.id, input("rpc"));
		await test1.bridge.settle();
		await vi.waitFor(async () => {
			expect(attachment.cleanups).toBeGreaterThan(0);
		});
	});

	test("manual panel close while running is terminal", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");

		await test1.registry.update(spawned.child.id, undefined, (current) => ({
			...current,
			state: "running",
		}));
		attachment.alive = false;
		test1.bridge.disconnect(spawned.child.id);
		await vi.waitFor(async () => {
			expect(await test1.manager.get(spawned.child.id)).toMatchObject({
				state: "error",
				freshness: "last_known",
			});
		});
		await expect(test1.manager.send(spawned.child.id, "continue")).resolves.toMatchObject({
			operation: "send",
			reason: expect.stringMatching(/never resumes|error state/),
			safeToRetry: false,
		});
		expect(attachment.cleanups).toBe(1);
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
		expect(await test1.registry.get(spawned.child.id)).toMatchObject({
			intent: "stopped",
			sessionId: spawned.child.sessionId,
		});
		expect(test1.tokens.forget).toHaveBeenCalledWith("runtime-1");
	});

	test("manual panel close while idle is done and not blocked", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");

		await test1.registry.update(spawned.child.id, undefined, (current) => ({
			...current,
			state: "done",
		}));
		attachment.alive = false;
		test1.bridge.disconnect(spawned.child.id);
		await vi.waitFor(async () => {
			expect(await test1.manager.get(spawned.child.id)).toMatchObject({
				state: "done",
				freshness: "last_known",
			});
			expect(attachment.cleanups).toBe(1);
		});
		expect(await test1.registry.get(spawned.child.id)).toMatchObject({
			intent: "active",
			sessionId: spawned.child.sessionId,
		});
	});

	test("send detecting a closed panel fails in that same call", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");
		attachment.alive = false;
		// The socket is already gone, but its disconnect notification has not been handled yet.
		test1.bridge.connected.delete(spawned.child.id);
		await expect(test1.manager.send(spawned.child.id, "continue")).resolves.toMatchObject({
			operation: "send",
			reason: expect.stringContaining("never resumes"),
			safeToRetry: false,
		});
		expect(test1.openPanel).toHaveBeenCalledTimes(1);
	});

	test("an adopted panel losing its bridge refuses send without guessing that it exited", async () => {
		const test1 = await harness({ host: true });
		const record = await test1.addChild("sa_adopted_closed", {
			state: "running",
			presentation: "panel",
			runtime: { runtimeIdentity: "runtime-before-restart", endpoint: "/tmp/parent.sock" },
		});
		test1.bridge.connect(record.subagentId);
		await test1.manager.recover();
		test1.bridge.disconnect(record.subagentId);
		await expect(test1.manager.send(record.subagentId, "continue")).resolves.toMatchObject({
			operation: "send",
			reason: expect.stringContaining("exit cannot be confirmed"),
			safeToRetry: false,
		});
		expect(test1.openPanel).not.toHaveBeenCalled();
		expect((await test1.registry.get(record.subagentId))?.runtime).toBeDefined();
	});

	test("keeps a panel standing when its child's bridge drops but the process lives", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({ agent: "worker", task: "Do the work." });
		if ("reason" in spawned) throw new Error(spawned.reason);
		const attachment = test1.panels.get(spawned.child.id);
		if (attachment === undefined) throw new Error("no panel was opened");

		// A live process behind a missing bridge may be serving the session the human switched to, and
		// nobody asked for that panel to be closed.
		test1.bridge.disconnect(spawned.child.id);
		await test1.bridge.settle();
		expect(attachment.cleanups).toBe(0);
		// Closing it stays possible on request: stop is an instruction, not an inference.
		expect(await test1.manager.stop(spawned.child.id)).toMatchObject({ state: "error" });
		expect(attachment.cleanups).toBe(1);
	});

	test("gives no idle countdown to a child whose runtime this process does not own", async () => {
		const test1 = await harness({ idleTimeoutMs: 10, host: true });
		await test1.addChild("sa_orphan", { state: "done", presentation: "panel" });
		test1.bridge.connect("sa_orphan");
		test1.bridge.emit("sa_orphan", {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});
		await test1.bridge.settle();

		await waitPastIdle(10);
		expect(test1.bridge.requests.some((request) => request.operation === "shutdown")).toBe(false);
		expect((await test1.registry.get("sa_orphan"))?.runtime).toBeUndefined();
	});

	test("extractLastAssistantText extracts string or structured text from the trailing assistant message", () => {
		const emptyEntries: unknown[] = [];
		expect(extractLastAssistantText(emptyEntries)).toBeUndefined();

		const noAssistant = [{ message: { role: "user", content: "hello" } }];
		expect(extractLastAssistantText(noAssistant)).toBeUndefined();

		const singleText = [
			{ message: { role: "user", content: "hello" } },
			{ message: { role: "assistant", content: "Hi there!" } },
		];
		expect(extractLastAssistantText(singleText)).toBe("Hi there!");

		const multiParts = [
			{ message: { role: "user", content: "hello" } },
			{ message: { role: "assistant", content: "Older reply" } },
			{ message: { role: "user", content: "next" } },
			{
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Part 1" },
						{ type: "toolCall", name: "read" },
						{ type: "text", text: "Part 2" },
					],
				},
			},
		];
		expect(extractLastAssistantText(multiParts)).toBe("Part 1\nPart 2");
	});

	test("registers subagent into TaskRegistry and updates on stop", async () => {
		const test1 = await harness();
		const taskRegistry = new TaskRegistry();
		test1.manager.bindTaskRegistry(taskRegistry);

		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Investigate database performance",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		const tasks = taskRegistry.list();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.id).toBe(childId);
		expect(tasks[0]?.type).toBe("agent");
		expect(tasks[0]?.purpose).toBe("worker: Investigate database performance");

		await test1.manager.stop(childId);
		const stoppedTasks = taskRegistry.list(true);
		expect(stoppedTasks[0]?.status).toBe("cancelled");
	});

	test("settles task as failed when child reports blocked via contactParent", async () => {
		const test1 = await harness();
		const taskRegistry = new TaskRegistry();
		test1.manager.bindTaskRegistry(taskRegistry);

		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Investigate database performance",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		await test1.manager.contactParent(childId, "blocked", "Missing credentials to access DB");
		expect(test1.reports).toHaveLength(1);
		expect(test1.reports[0]?.reason).toBe("blocked");
		expect(test1.reports[0]?.message).toBe("Missing credentials to access DB");

		const [outcome] = await taskRegistry.wait([childId]);
		expect(outcome?.status).toBe("failed");
		if (outcome?.status === "failed") {
			expect(outcome.output).toBe("Missing credentials to access DB");
		}
	});

	test("reports blocked and settles task as failed when subagent encounters error and settles", async () => {
		const test1 = await harness();
		const taskRegistry = new TaskRegistry();
		test1.manager.bindTaskRegistry(taskRegistry);

		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Investigate database performance",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		test1.bridge.responses.set(`${childId}:get_entries`, async () => ({
			entries: [
				{
					type: "message",
					id: "msg-1",
					message: {
						role: "assistant",
						stopReason: "error",
						errorMessage: "Rate limit exceeded",
						content: [{ type: "text", text: "Attempting to query..." }],
					},
				},
			],
		}));

		await test1.manager.handleEvent(childId, {
			type: "agent_end",
		});
		await test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "Rate limit exceeded",
			},
		});

		await vi.waitFor(
			() => {
				expect(test1.reports.length).toBeGreaterThan(0);
			},
			{ timeout: 6_000 },
		);

		expect(test1.reports[0]?.reason).toBe("blocked");
		expect(test1.reports[0]?.message).toContain("Rate limit exceeded");

		const [outcome] = await taskRegistry.wait([childId]);
		expect(outcome?.status).toBe("failed");
		if (outcome?.status === "failed") {
			expect(outcome.output).toContain("Rate limit exceeded");
		}
	}, 10_000);

	test("does not report error while retrying and reports success after successful retry", async () => {
		const test1 = await harness();
		const taskRegistry = new TaskRegistry();
		test1.manager.bindTaskRegistry(taskRegistry);

		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Investigate database performance",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		await test1.manager.handleEvent(childId, {
			type: "agent_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "Rate limit exceeded",
			},
		});
		await test1.manager.handleEvent(childId, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
		});

		expect(test1.reports).toHaveLength(0);

		await test1.manager.handleEvent(childId, {
			type: "agent_start",
		});
		test1.bridge.responses.set(`${childId}:get_entries`, async () => ({
			entries: [
				{
					type: "message",
					id: "msg-1",
					message: {
						role: "assistant",
						stopReason: "error",
						errorMessage: "Rate limit exceeded",
					},
				},
				{
					type: "message",
					id: "msg-2",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "Successfully completed after retry." }],
					},
				},
			],
		}));
		await test1.manager.handleEvent(childId, {
			type: "agent_end",
		});
		await test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: {
				role: "assistant",
				stopReason: "stop",
			},
		});

		await vi.waitFor(
			() => {
				expect(test1.reports.length).toBeGreaterThan(0);
			},
			{ timeout: 6_000 },
		);

		expect(test1.reports).toHaveLength(1);
		expect(test1.reports[0]?.reason).toBe("success");
		expect(test1.reports[0]?.message).toBe("Successfully completed after retry.");

		const [outcome] = await taskRegistry.wait([childId]);
		expect(outcome?.status).toBe("completed");
		if (outcome?.status === "completed") {
			expect(outcome.output).toBe("Successfully completed after retry.");
		}

		expect((await test1.manager.get(childId)).state).toBe("done");
	}, 10_000);

	test("automatically closes panel after failedPanelCloseTimeoutMs when child reports blocked", async () => {
		const test1 = await harness({ host: true, failedPanelCloseTimeoutMs: 50 });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Fix broken component",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		const panel = test1.panels.get(childId);
		expect(panel).toBeDefined();
		expect(panel?.cleanups).toBe(0);

		await test1.manager.contactParent(childId, "blocked", "Unrecoverable compile error");
		expect(test1.reports).toHaveLength(1);
		expect(test1.reports[0]?.reason).toBe("blocked");

		// Panel should not be closed immediately (it has a 50ms countdown)
		expect(panel?.cleanups).toBe(0);

		// Wait for countdown to expire
		await vi.waitFor(
			() => {
				expect(panel?.cleanups).toBe(1);
			},
			{ timeout: 1_000 },
		);

		const updatedRecord = await test1.manager.get(childId);
		expect(updatedRecord.state).toBe("blocked");
	});

	test("cancels panel close countdown if a new message is sent before timeout", async () => {
		const test1 = await harness({ host: true, failedPanelCloseTimeoutMs: 100 });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Fix broken component",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		const panel = test1.panels.get(childId);
		expect(panel).toBeDefined();
		expect(panel?.cleanups).toBe(0);

		await test1.manager.contactParent(childId, "blocked", "Need more info");
		expect(panel?.cleanups).toBe(0);

		// Send new instructions to resume work before the 100ms timer fires
		await test1.manager.send(childId, "Try using the alternative API instead");

		// Wait 150ms and confirm cleanup was NOT called because send cancelled it
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(panel?.cleanups).toBe(0);
	});

	test("closing an idle panel marks state as done without interrupted, keeping intent active", async () => {
		const test1 = await harness({ host: true });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Initial background inspection",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		// Settle child into idle
		test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: {
				role: "assistant",
				stopReason: "stop",
			},
		});
		await vi.waitFor(async () => {
			const rec = await test1.manager.get(childId);
			expect(rec.state).toBe("done");
		});

		const panel = test1.panels.get(childId);
		expect(panel).toBeDefined();

		// Simulate user closing the panel tab (panel observation reports alive = false)
		if (panel) panel.alive = false;
		test1.bridge.disconnect(childId);

		await vi.waitFor(async () => {
			const rec = await test1.manager.get(childId);
			if ("reason" in rec) throw new Error(rec.reason);
			expect(rec.state).toBe("done");
			expect(rec.interrupted).toBeUndefined();
		});

		expect((await test1.registry.get(childId))?.intent).toBe("active");

		// Re-awaken via send
		const resumed = await test1.manager.send(childId, "Follow-up task after panel close");
		if ("reason" in resumed) throw new Error(resumed.reason);
		expect(resumed.id).toBe(childId);
		expect(resumed.state).toBe("running");
	});

	test("blocked subagent panel closes after timeout and can be re-awakened via send", async () => {
		const test1 = await harness({ host: true, failedPanelCloseTimeoutMs: 50 });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Blocked panel reawaken test",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		const panel = test1.panels.get(childId);
		expect(panel).toBeDefined();

		// Report blocked
		await test1.manager.contactParent(childId, "blocked", "Waiting for auth token");

		const blockedRecord = await test1.manager.get(childId);
		expect(blockedRecord.state).toBe("blocked");

		// Wait out the 50ms close timeout
		await new Promise((resolve) => setTimeout(resolve, 80));

		// Panel should now be cleaned up and closed
		expect(panel?.cleanups).toBe(1);

		// Record state is still blocked
		const afterClose = await test1.manager.get(childId);
		expect(afterClose.state).toBe("blocked");

		// Can be re-awakened via send
		const sent = await test1.manager.send(childId, "Here is your token: secret123");
		if ("reason" in sent) throw new Error(sent.reason);
		expect(sent.id).toBe(childId);
		expect(sent.state).toBe("running");

		// A new panel was opened to resume the session
		expect(test1.openPanel).toHaveBeenCalledTimes(2);
	});

	test("error subagent reports error, marks failed, and cannot be resumed via send", async () => {
		const test1 = await harness({ host: true, failedPanelCloseTimeoutMs: 50 });
		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Error report test",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		// Report fatal error
		await test1.manager.contactParent(childId, "error", "Fatal unrecoverable crash");

		const errorRecord = await test1.manager.get(childId);
		expect(errorRecord.state).toBe("error");

		// Send is refused because error cannot continue
		const sent = await test1.manager.send(childId, "Try to continue anyway");
		expect(sent).toMatchObject({
			operation: "send",
			safeToRetry: false,
			reason: expect.stringMatching(/never resumes|unrecoverable error/),
		});
	});

	test("spawns subagent with inlineResult: true so TaskRegistry does not treat it as pending delivery", async () => {
		const test1 = await harness();
		const taskRegistry = new TaskRegistry();
		test1.manager.bindTaskRegistry(taskRegistry);

		const spawned = await test1.manager.spawn({
			agent: "worker",
			task: "Concurrent work test",
			presentation: "auto",
		});
		if ("reason" in spawned) throw new Error(spawned.reason);
		const childId = spawned.child.id;

		expect(taskRegistry.pendingDeliveries()).toHaveLength(0);

		// Settle the subagent
		test1.bridge.responses.set(`${childId}:get_entries`, async () => ({
			entries: [
				{
					type: "message",
					id: "msg-1",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "Finished successfully" }],
					},
				},
			],
		}));
		await test1.manager.handleEvent(childId, {
			type: "agent_end",
		});
		await test1.manager.handleEvent(childId, {
			type: "agent_settled",
			message: { role: "assistant", stopReason: "stop" },
		});

		await vi.waitFor(
			() => {
				expect(test1.reports.length).toBeGreaterThan(0);
			},
			{ timeout: 6_000 },
		);

		// Subagent is reported via parent channel
		expect(test1.reports[0]?.message).toBe("Finished successfully");
		// TaskRegistry outcome is settled and waitable
		const [outcome] = await taskRegistry.wait([childId]);
		expect(outcome?.status).toBe("completed");
		// TaskRegistry has no pending deliveries (no duplicate task-terminal)
		expect(taskRegistry.pendingDeliveries()).toHaveLength(0);
	}, 10_000);
});
