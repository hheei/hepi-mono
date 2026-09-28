import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { EffectiveLaunchConfig, SubagentRecord } from "../src/domain.js";
import type { HostAdapter, HostAttachment } from "../src/host-adapter.js";
import {
	type AttachHost,
	type ManagerDependencies,
	type RunnerLike,
	SubagentManager,
} from "../src/manager.js";
import { type SubagentRegistry, SubagentRegistryError } from "../src/registry.js";
import {
	createRuntimeTokenStore,
	isPidConfirmedDead,
	isRecordedRunnerConfirmedDead,
} from "../src/runtime.js";

const PARENT_ID = "parent-test";
const CHILD_ID = "sa_manager";

function launchConfig(): EffectiveLaunchConfig {
	return {
		subagentId: CHILD_ID,
		invocation: { command: process.execPath, args: ["pi.js"] },
		cwd: process.cwd(),
		sessionId: "session-test",
		sessionDir: "/tmp/sessions",
		agent: {
			name: "worker",
			hidden: false,
			sourcePath: "/tmp/worker.md",
			instructions: "Work.",
		},
		model: { provider: "test", id: "model", source: "parent" },
		thinking: { level: "off", source: "parent" },
		tools: ["contact_parent"],
		excludeTools: [],
		extensions: { discovery: false, paths: ["/tmp/extension.js"] },
		skills: { discovery: false, paths: [] },
		prompt: "Work.",
		bridgeExtensionPath: "/tmp/extension.js",
		interactive: false,
	};
}

function childRecord(state: SubagentRecord["state"] = "idle"): SubagentRecord {
	return {
		subagentId: CHILD_ID,
		parentSessionId: PARENT_ID,
		revision: 1,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		sessionId: "session-test",
		cwd: process.cwd(),
		initialTask: "Work.",
		intent: "active",
		state,
		mode: "rpc",
		persistence: "never_flushed",
		launchConfig: launchConfig(),
		runtime: { runtimeIdentity: "runtime-test", endpoint: "/tmp/runner.sock" },
	};
}

function memoryRegistry(
	initial?: SubagentRecord,
): SubagentRegistry & { current: SubagentRecord | undefined } {
	const store: SubagentRegistry & { current: SubagentRecord | undefined } = {
		current: initial,
		path: "/tmp/registry.json",
		parentSessionId: PARENT_ID,
		async get(id) {
			return id === store.current?.subagentId ? store.current : undefined;
		},
		async list() {
			return store.current === undefined ? [] : [store.current];
		},
		async create(record) {
			store.current = record;
			return record;
		},
		async update(id, expectedRevision, updater, expectedRuntimeIdentity) {
			const current = store.current;
			if (current === undefined || current.subagentId !== id) throw new Error("unknown child");
			if (expectedRevision !== undefined && current.revision !== expectedRevision) {
				throw new SubagentRegistryError("stale_revision", "stale revision");
			}
			if (
				expectedRuntimeIdentity !== undefined &&
				current.runtime?.runtimeIdentity !== expectedRuntimeIdentity
			)
				throw new Error("runtime mismatch");
			store.current = {
				...updater(current),
				revision: current.revision + 1,
				updatedAt: new Date(current.revision * 1_000).toISOString(),
			};
			return store.current;
		},
		async claim(id, expectedRevision, claim) {
			return store.update(id, expectedRevision, (current) => ({ ...current, claim }));
		},
		async markClaimRunner(id, claimId, runnerPid) {
			const current = store.current;
			if (current?.claim?.claimId !== claimId) throw new Error("claim mismatch");
			return store.update(id, current.revision, (value) => ({
				...value,
				claim: { ...value.claim!, runnerPid },
			}));
		},
		async activateClaim(id, claimId, runnerPid) {
			const current = store.current;
			if (current?.claim?.claimId !== claimId) throw new Error("claim mismatch");
			return store.update(id, current.revision, (value) => {
				const claim = value.claim!;
				const { claim: _claim, ...rest } = value;
				return {
					...rest,
					runtime: {
						runtimeIdentity: claim.runtimeIdentity,
						endpoint: claim.endpoint,
						pid: runnerPid,
					},
				};
			});
		},
		async consumeReconnectClaim(id, claimId, controllerTokenHash, expectedRuntimeIdentity) {
			const current = store.current;
			if (
				current?.claim?.claimId !== claimId ||
				current.claim.controllerTokenHash !== controllerTokenHash ||
				(expectedRuntimeIdentity !== undefined &&
					current.runtime?.runtimeIdentity !== expectedRuntimeIdentity)
			)
				throw new Error("claim mismatch");
			return store.update(id, current.revision, (value) => {
				const { claim: _claim, ...rest } = value;
				return rest;
			});
		},
		async releaseClaim(id, claimId) {
			const current = store.current;
			if (current?.claim?.claimId !== claimId) throw new Error("claim mismatch");
			return store.update(id, current.revision, (value) => {
				const { claim: _claim, ...rest } = value;
				return rest;
			});
		},
	};
	return store;
}

class FakeRunner implements RunnerLike {
	public connected = true;
	public busy = false;
	public writerClosed = false;
	public readonly requests: string[] = [];
	public rejectSend = false;
	public rejectPrompt = false;
	public rejectCloseWriter = false;
	public rejectStartRpc = false;
	public pauseCancelled = false;
	#pauseWaiter:
		| { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
		| undefined;
	readonly #listeners = new Set<(event: unknown) => void>();

	public ackPause(generation = 1): void {
		this.busy = false;
		this.#pauseWaiter?.resolve({ paused: true, idle: false, generation });
		this.#pauseWaiter = undefined;
	}

	public async request(operation: Parameters<RunnerLike["request"]>[0]): Promise<unknown> {
		this.requests.push(operation);
		if (this.rejectPrompt && operation === "prompt") throw new Error("connection lost");
		if (this.rejectSend && operation === "follow_up") throw new Error("connection lost");
		if (operation === "get_state")
			return {
				isStreaming: this.busy,
				isCompacting: false,
				pendingMessageCount: 0,
			};
		if (operation === "pause") {
			if (!this.busy) return { paused: true, idle: true, generation: 0 };
			return new Promise((resolve, reject) => {
				this.#pauseWaiter = { resolve, reject };
			});
		}
		if (operation === "cancel_pause") {
			this.pauseCancelled = true;
			this.#pauseWaiter?.reject(new Error("pause cancelled"));
			this.#pauseWaiter = undefined;
			return { cancelled: true };
		}
		if (operation === "close_writer") {
			if (this.rejectCloseWriter) throw new Error("close_writer failed");
			this.writerClosed = true;
			return { closed: true };
		}
		if (operation === "start_rpc") {
			if (this.rejectStartRpc) throw new Error("start_rpc failed");
			this.writerClosed = false;
			return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
		}
		if (operation === "shutdown") {
			queueMicrotask(() => this.emit({ type: "agent_start" }));
			this.connected = false;
		}
		if (operation === "get_entries") return { entries: [] };
		return undefined;
	}

	public close(): void {
		this.connected = false;
	}

	public onEvent(listener: (event: unknown) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public emit(event: unknown): void {
		for (const listener of this.#listeners) listener(event);
	}
}

/** A real process that carries the runtime identity a record refers to. */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("condition was never met");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

async function spawnRecordedRuntime(): Promise<{ readonly pid: number; stop: () => void }> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		env: { ...process.env, PI_SUBAGENTS_RUNTIME_ID: "runtime-test" },
		stdio: "ignore",
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error("test runtime did not start");
	const deadline = Date.now() + 5_000;
	// Wait until the process is observable as the recorded runtime, never merely alive.
	while (
		await isRecordedRunnerConfirmedDead({
			runtime: { runtimeIdentity: "runtime-test", endpoint: "/tmp/runner.sock", pid },
		} as SubagentRecord)
	) {
		if (Date.now() >= deadline) throw new Error("test runtime did not become observable");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	return { pid, stop: () => child.kill("SIGKILL") };
}

function managerWith(
	record: SubagentRecord,
	runner: FakeRunner,
	registry = memoryRegistry(record),
	extra: Partial<ManagerDependencies> = {},
) {
	const manager = new SubagentManager({
		parentSessionId: PARENT_ID,
		registry,
		resolve: async () => launchConfig(),
		bootstrap: async () => record,
		launch: async () => runner,
		deadlineMs: 1_000,
		...extra,
	});
	return { manager, registry };
}

function readyHost(attach: HostAdapter["attach"]): AttachHost {
	const adapter: HostAdapter = {
		kind: "herdr",
		probe: async () => ({ host: "herdr", available: true, reason: "ready" }),
		attach,
	};
	return {
		async select() {
			return {
				available: true,
				selectedHost: "herdr",
				adapter,
				explicit: false,
				reason: "ready",
				attempts: [],
			};
		},
	};
}

function hostAttachment(
	cleanup: HostAttachment["cleanup"] = async () => ({
		stdout: "",
		stderr: "",
		exitCode: 0,
		timedOut: false,
	}),
	observeAlive = true,
): HostAttachment & { setAlive(next: boolean): void } {
	const identity = { host: "herdr" as const, attachmentId: "pane-1", createdBy: PARENT_ID };
	let alive = observeAlive;
	return {
		identity,
		launch: { stdout: "", stderr: "", exitCode: 0, timedOut: false },
		async observe() {
			return { identity, alive, known: true, detail: "ok" };
		},
		async cleanup() {
			const result = await cleanup();
			if (result.exitCode === 0 && !result.timedOut) alive = false;
			return result;
		},
		setAlive(next) {
			alive = next;
		},
	};
}

async function flushedSessionPath(sessionId = "session-test"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagents-attach-"));
	const sessionPath = join(dir, `${sessionId}.jsonl`);
	await writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd: dir })}\n`);
	return sessionPath;
}

function markIdleFlushed(
	registry: { current: SubagentRecord | undefined },
	sessionPath: string,
	state: SubagentRecord["state"] = "idle",
): void {
	const current = registry.current!;
	registry.current = {
		...current,
		state,
		persistence: "flushed",
		sessionPath,
		launchConfig: { ...current.launchConfig, sessionPath },
	};
}

function attachDeps(attach: HostAdapter["attach"]): Partial<ManagerDependencies> {
	const tokens = createRuntimeTokenStore();
	tokens.remember("runtime-test", "bridge-token");
	return {
		tokens,
		attachHost: readyHost(attach),
	};
}

describe("SubagentManager contracts", () => {
	test("marks uncertain input non-retryable and persists it before dispatch", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const { manager, registry } = managerWith(record, runner);
		await manager.spawn({ task: "Work.", agent: "worker" });
		registry.current = { ...registry.current!, state: "idle" };
		runner.rejectSend = true;

		const result = await manager.send(CHILD_ID, "next", "auto");
		expect(result).toMatchObject({ safeToRetry: false });
		expect(registry.current).toMatchObject({
			unacknowledgedInput: "next",
			interrupted: expect.stringContaining("not yet confirmed"),
		});
	});

	test("keeps a launched child controllable when initial delivery is uncertain", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		runner.rejectPrompt = true;
		const { manager, registry } = managerWith(record, runner);

		const result = await manager.spawn({ task: "Work.", agent: "worker" });

		expect(result).toMatchObject({ childId: CHILD_ID, state: "failed", safeToRetry: false });
		expect(registry.current).toMatchObject({
			state: "failed",
			unacknowledgedInput: "Work.",
			interrupted: expect.stringContaining("not confirmed"),
		});
		expect(await manager.get(CHILD_ID)).toMatchObject({ freshness: "live" });
		expect(await manager.stop(CHILD_ID)).toMatchObject({ state: "stopped" });
	});

	test("retains runtime metadata when stop has no attached controller", async () => {
		const record = childRecord("running");
		const registry = memoryRegistry(record);
		const manager = new SubagentManager({
			parentSessionId: PARENT_ID,
			registry,
			resolve: async () => launchConfig(),
			bootstrap: async () => record,
			launch: async () => new FakeRunner(),
		});

		const result = await manager.stop(CHILD_ID);

		expect(result).toMatchObject({
			state: "stopped",
			safeToRetry: true,
			sideEffects: ["stopped intent persisted", "runtime metadata retained"],
		});
		expect(registry.current?.runtime).toEqual(record.runtime);
	});

	test("stop is not reported as stopped while the child process is still alive", async () => {
		const runtime = await spawnRecordedRuntime();
		try {
			const record = childRecord("running");
			const runtimeMetadata = record.runtime;
			if (runtimeMetadata === undefined) throw new Error("the fixture needs runtime metadata");
			const live: SubagentRecord = {
				...record,
				runtime: { ...runtimeMetadata, pid: runtime.pid },
			};
			const runner = new FakeRunner();
			const { manager, registry } = managerWith(live, runner);
			await manager.spawn({ task: "Work.", agent: "worker" });

			// The shutdown request was answered and the socket closed, but the process is still there:
			// reporting a clean stop would let the caller free the capacity it still occupies.
			const refused = await manager.stop(CHILD_ID);
			expect(refused).toMatchObject({
				state: "stopped",
				safeToRetry: true,
				sideEffects: ["stopped intent persisted", "runtime metadata retained"],
			});
			expect(registry.current?.runtime).toEqual(live.runtime);

			// A dead process is proof, so the retry finishes the stop and lets the evidence go.
			runtime.stop();
			expect(await manager.stop(CHILD_ID)).toMatchObject({ state: "stopped" });
			expect(registry.current?.runtime).toBeUndefined();
		} finally {
			runtime.stop();
		}
	});

	test("stop wins over a late runtime event and clears matching runtime metadata", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const { manager, registry } = managerWith(record, runner);
		await manager.spawn({ task: "Work.", agent: "worker" });

		const result = await manager.stop(CHILD_ID);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(result).toMatchObject({ state: "stopped", freshness: "last_known" });
		expect(registry.current?.state).toBe("stopped");
		expect(registry.current?.runtime).toBeUndefined();
	});
	test("get and list stop calling a disconnected handle live", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const { manager } = managerWith(record, runner);
		await manager.spawn({ task: "Work.", agent: "worker" });
		runner.connected = false;
		expect(await manager.get(CHILD_ID)).toMatchObject({
			freshness: "last_known",
			interactive: false,
			model: { provider: "test", id: "model", source: "parent" },
			thinking: { level: "off", source: "parent" },
		});
		expect(await manager.list()).toEqual([
			expect.objectContaining({ freshness: "last_known", interactive: false }),
		]);
	});

	test("delivers only an authenticated report for the current runtime", async () => {
		const delivered = vi.fn(async () => undefined);
		const channel = { deliver: delivered };
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const registry = memoryRegistry(record);
		const manager = new SubagentManager({
			parentSessionId: PARENT_ID,
			registry,
			resolve: async () => launchConfig(),
			bootstrap: async () => record,
			launch: async () => runner,
			channel,
		});
		await manager.spawn({ task: "Work.", agent: "worker" });
		runner.emit({
			type: "subagent_report",
			report: {
				type: "pi_subagent_report",
				parentSessionId: PARENT_ID,
				childId: CHILD_ID,
				runtimeIdentity: "runtime-test",
				reason: "important_finding",
				message: "found it",
			},
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(delivered).toHaveBeenCalledWith(
			expect.objectContaining({ message: "found it", agent: "worker", childId: CHILD_ID }),
		);
	});
	test("recovers a persisted child without replaying its task", async () => {
		const record = { ...childRecord("idle"), unacknowledgedInput: "Work." };
		const runner = new FakeRunner();
		const registry = memoryRegistry(record);
		const connect = vi.fn(async () => runner);
		const manager = new SubagentManager({
			parentSessionId: PARENT_ID,
			registry,
			resolve: async () => launchConfig(),
			bootstrap: async () => record,
			launch: async () => new FakeRunner(),
			connect,
		});

		const result = await manager.recover();

		expect(result).toEqual({ recovered: [CHILD_ID], failures: [] });
		expect(connect).toHaveBeenCalledOnce();
		expect(runner.requests).toEqual(["get_entries"]);
		expect(await manager.get(CHILD_ID)).toMatchObject({
			freshness: "live",
			interrupted: "Parent recovered; pending input was not replayed",
		});
	});

	test("skips stopped children and reports connect failures without hanging", async () => {
		const stopped = { ...childRecord("stopped"), intent: "stopped" as const };
		const registry = memoryRegistry(stopped);
		const connect = vi.fn(async () => new FakeRunner());
		const manager = new SubagentManager({
			parentSessionId: PARENT_ID,
			registry,
			resolve: async () => launchConfig(),
			bootstrap: async () => stopped,
			launch: async () => new FakeRunner(),
			connect,
		});
		expect(await manager.recover()).toEqual({ recovered: [], failures: [] });
		expect(connect).not.toHaveBeenCalled();

		const live = childRecord("idle");
		registry.current = live;
		connect.mockRejectedValueOnce(new Error("endpoint missing"));
		expect(await manager.recover()).toEqual({
			recovered: [],
			failures: [{ childId: CHILD_ID, reason: "endpoint missing" }],
		});
		expect(await manager.get(CHILD_ID)).toMatchObject({ state: "idle", freshness: "last_known" });
	});

	test("notifies presentation listeners after spawn and exposes interactive", async () => {
		const base = childRecord("starting");
		const record = { ...base, launchConfig: { ...base.launchConfig, interactive: true } };
		const runner = new FakeRunner();
		const { manager } = managerWith(record, runner);
		const seen: number[] = [];
		const unsubscribe = manager.onChange(() => seen.push(seen.length));
		await manager.spawn({ task: "Work.", agent: "worker" });
		expect(seen.length).toBeGreaterThan(0);
		expect(await manager.get(CHILD_ID)).toMatchObject({
			interactive: true,
			freshness: "live",
			agent: "worker",
		});
		unsubscribe();
	});

	test("hibernates an idle child after idleTimeoutMs, shuts down runner, and marks state done", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const { manager, registry } = managerWith(record, runner, memoryRegistry(record), {
			idleTimeoutMs: 20,
		});
		await manager.spawn({ task: "Work.", agent: "worker" });

		// Simulate child finishing and becoming idle
		runner.emit({ type: "agent_end" });
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		expect(registry.current?.state).toBe("idle");
		expect(runner.requests).not.toContain("shutdown");

		// Advance past the 20ms idle timeout
		await new Promise<void>((resolve) => setTimeout(resolve, 35));
		expect(runner.requests).toContain("shutdown");
		expect(registry.current?.state).toBe("done");

		manager.dispose();
	});

	test("keeps runtime evidence and refuses the child when a hibernating runner never confirms exit", async () => {
		const runtime = await spawnRecordedRuntime();
		try {
			const baseline = childRecord("starting");
			const record: SubagentRecord = {
				...baseline,
				runtime: { ...baseline.runtime!, pid: runtime.pid },
			};
			const runner = new FakeRunner();
			const { manager, registry } = managerWith(record, runner, memoryRegistry(record), {
				idleTimeoutMs: 20,
				deadlineMs: 100,
			});
			await manager.spawn({ task: "Work.", agent: "worker" });
			runner.emit({ type: "agent_end" });
			await new Promise<void>((resolve) => setTimeout(resolve, 220));

			// The runner acknowledged shutdown, but the recorded process is still alive.
			expect(runner.requests).toContain("shutdown");
			expect(registry.current?.state).toBe("failed");
			expect(registry.current?.interrupted).toContain("unconfirmed");
			expect(registry.current?.runtime?.pid).toBe(runtime.pid);
			// No blind second execution is attempted while the old runtime may still own the session.
			expect(await manager.send(CHILD_ID, "Follow up", "auto")).toMatchObject({
				reason: "Child is not accepting input",
			});
			manager.dispose();
		} finally {
			runtime.stop();
		}
	});

	test("refuses to hibernate when the child session placement cannot be verified", async () => {
		const parent = await mkdtemp(join(tmpdir(), "pi-subagents-placement-"));
		const blocker = join(parent, "sessions");
		await writeFile(blocker, "not a directory");
		const baseline = childRecord("starting");
		const record: SubagentRecord = {
			...baseline,
			launchConfig: { ...baseline.launchConfig, sessionDir: blocker },
		};
		const runner = new FakeRunner();
		let launches = 0;
		const { manager, registry } = managerWith(record, runner, memoryRegistry(record), {
			idleTimeoutMs: 20,
			launch: async () => {
				launches += 1;
				return runner;
			},
		});
		await manager.spawn({ task: "Work.", agent: "worker" });
		runner.emit({ type: "agent_end" });
		await new Promise<void>((resolve) => setTimeout(resolve, 60));

		// An unreadable session directory is not proof that the session does not exist, so the
		// child keeps its id and stays inspectable instead of hibernating with a stale placement.
		const settled = registry.current;
		expect(settled?.state).toBe("idle");
		expect(settled?.persistence).toBe("never_flushed");
		expect(settled?.sessionPath).toBeUndefined();
		expect(settled?.interrupted).toContain("could not be verified");
		const resumed = await manager.send(CHILD_ID, "Follow up", "auto");
		expect(resumed).toMatchObject({ reason: expect.stringContaining("could not be verified") });
		expect(launches).toBe(1);
		manager.dispose();
	});

	test("separates a resume that never started from one that left a runtime behind", async () => {
		const neverStarted = childRecord("done");
		const first = managerWith(neverStarted, new FakeRunner(), memoryRegistry(neverStarted), {
			launch: async () => {
				throw new Error("handshake failed");
			},
		});
		const failedStart = await first.manager.send(CHILD_ID, "Follow up", "auto");
		expect(failedStart).toMatchObject({ safeToRetry: true, state: "done" });
		expect(first.registry.current).toMatchObject({ state: "done" });
		expect(first.registry.current?.interrupted).toContain("before a runtime was confirmed started");
		first.manager.dispose();

		// A claim written before the spawn is the only evidence left when the launch fails
		// during the handshake and no pid was recorded yet: retrying would risk a second runner
		// for the same session, so this must count as an unconfirmed start.
		const claimedOnly = childRecord("done");
		const claimRegistry = memoryRegistry(claimedOnly);
		const third = managerWith(claimedOnly, new FakeRunner(), claimRegistry, {
			launch: async () => {
				await claimRegistry.update(CHILD_ID, undefined, (value) => ({
					...value,
					claim: {
						claimId: "claim-1",
						kind: "replacement",
						holderPid: process.pid,
						runtimeIdentity: "runtime-1",
						endpoint: "/tmp/nowhere.sock",
						controllerTokenHash: "hash",
					},
				}));
				throw new Error("handshake aborted");
			},
		});
		const claimUnconfirmed = await third.manager.send(CHILD_ID, "Follow up", "auto");
		expect(claimUnconfirmed).toMatchObject({ safeToRetry: false, state: "failed" });
		expect(claimRegistry.current?.interrupted).toContain("after the runtime was claimed");
		third.manager.dispose();

		const runtime = await spawnRecordedRuntime();
		try {
			const claimed = childRecord("done");
			const registry = memoryRegistry(claimed);
			const second = managerWith(claimed, new FakeRunner(), registry, {
				launch: async () => {
					await registry.update(CHILD_ID, undefined, (value) => ({
						...value,
						runtime: { ...value.runtime!, pid: runtime.pid },
					}));
					throw new Error("handshake timed out");
				},
			});
			const unconfirmed = await second.manager.send(CHILD_ID, "Follow up", "auto");
			expect(unconfirmed).toMatchObject({ safeToRetry: false, state: "failed" });
			expect(registry.current?.interrupted).toContain("after the runtime was claimed");
			expect(registry.current?.runtime?.pid).toBe(runtime.pid);
			second.manager.dispose();
		} finally {
			runtime.stop();
		}
	});

	test("frees a failed child once its runner is confirmed gone", async () => {
		const runtime = await spawnRecordedRuntime();
		const failed = childRecord("failed");
		const record: SubagentRecord = {
			...failed,
			runtime: { runtimeIdentity: "runtime-test", endpoint: "/tmp/runner.sock", pid: runtime.pid },
		};
		const registry = memoryRegistry(record);
		let launches = 0;
		const { manager } = managerWith(record, new FakeRunner(), registry, {
			launch: async () => {
				launches += 1;
				throw new Error("handshake failed");
			},
		});

		// The recorded process is still alive, so a second execution must not be started for the
		// session it owns: the failed child stays unavailable.
		const refused = await manager.send(CHILD_ID, "Follow up", "auto");
		expect(refused).toMatchObject({ reason: "Child is not accepting input", state: "failed" });
		// Nothing was launched, so this attempt consumed nothing.
		expect(launches).toBe(0);

		// Once nothing can be running, refusing input forever would strand a session nobody uses.
		runtime.stop();
		await until(() => isPidConfirmedDead(runtime.pid));
		const revived = await manager.send(CHILD_ID, "Follow up", "auto");
		expect(launches).toBe(1);
		expect(revived).toMatchObject({ safeToRetry: true, state: "done" });
		expect(registry.current?.state).toBe("done");
		manager.dispose();
	});

	test("frees a dead claim instead of leaving the child unusable", async () => {
		const runtime = await spawnRecordedRuntime();
		const pid = runtime.pid;
		runtime.stop();
		await until(() => isPidConfirmedDead(pid));
		const claimed: SubagentRecord = {
			...childRecord("failed"),
			claim: {
				claimId: "claim-1",
				kind: "replacement",
				holderPid: process.pid,
				runtimeIdentity: "runtime-1",
				endpoint: "/tmp/nowhere.sock",
				controllerTokenHash: "hash",
				runnerPid: pid,
			},
		};
		const registry = memoryRegistry(claimed);
		const { manager } = managerWith(claimed, new FakeRunner(), registry, {
			launch: async () => {
				throw new Error("handshake aborted");
			},
		});

		// The claim belongs to this parent and its runner is gone, so it blocks nothing any more.
		const revived = await manager.send(CHILD_ID, "Follow up", "auto");
		expect(registry.current?.claim).toBeUndefined();
		expect(revived).toMatchObject({ safeToRetry: true, state: "done" });
		manager.dispose();
	});

	test("auto-resumes a done or hibernated child on send with prompt operation", async () => {
		const record = childRecord("starting");
		const runner1 = new FakeRunner();
		const runner2 = new FakeRunner();
		let launches = 0;
		const registry = memoryRegistry(record);
		const manager = new SubagentManager({
			parentSessionId: PARENT_ID,
			registry,
			resolve: async () => launchConfig(),
			bootstrap: async () => record,
			launch: async () => {
				launches += 1;
				return launches === 1 ? runner1 : runner2;
			},
			deadlineMs: 1_000,
			idleTimeoutMs: 20,
		});
		await manager.spawn({ task: "Work.", agent: "worker" });

		// Transition to idle then hibernate to done
		runner1.emit({ type: "agent_end" });
		await new Promise<void>((resolve) => setTimeout(resolve, 35));
		expect(registry.current?.state).toBe("done");

		// Send message to the done child -> triggers Auto-Resume
		const resumed = await manager.send(CHILD_ID, "Follow up task", "auto");
		expect(launches).toBe(2);
		expect(runner2.requests).toContain("prompt");
		expect(resumed).toMatchObject({ state: "running", freshness: "live" });
		expect(registry.current?.state).toBe("running");

		manager.dispose();
	});
});

describe("SubagentManager native TUI attach", () => {
	test("attaches an idle flushed child and restores RPC after host cleanup", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const sessionPath = await flushedSessionPath();
		const { manager, registry } = managerWith(
			record,
			runner,
			memoryRegistry(record),
			attachDeps(async (spec) => {
				expect(spec.mode).toBe("tui");
				expect(spec.stdio).toBe("inherit");
				expect(spec.env.PI_SUBAGENTS_TOKEN).toBe("bridge-token");
				return hostAttachment();
			}),
		);
		await manager.spawn({ task: "Work.", agent: "worker" });
		markIdleFlushed(registry, sessionPath);

		const attached = await manager.attach(CHILD_ID);
		expect(attached).toMatchObject({
			host: "herdr",
			attachmentId: "pane-1",
			child: { id: CHILD_ID, mode: "tui", state: "idle" },
		});
		expect(runner.writerClosed).toBe(true);
		expect(runner.requests).toContain("close_writer");
		expect(await manager.get(CHILD_ID)).toMatchObject({ mode: "tui" });
		expect(manager.ownsHostAttachment({ host: "herdr", attachmentId: "pane-1" })).toBe(true);

		expect(await manager.send(CHILD_ID, "later")).toMatchObject({
			reason: "Child input is frozen for attach",
		});

		const restored = await manager.restoreRpc(CHILD_ID);
		expect(restored).toMatchObject({ id: CHILD_ID, mode: "rpc" });
		expect(runner.requests).toContain("start_rpc");
		expect(runner.writerClosed).toBe(false);
		expect(manager.ownsHostAttachment({ host: "herdr", attachmentId: "pane-1" })).toBe(false);
		expect(await manager.send(CHILD_ID, "later")).toMatchObject({ id: CHILD_ID });
	});

	test("does not restore RPC when host cleanup cannot confirm the TUI is gone", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const sessionPath = await flushedSessionPath();
		const { manager, registry } = managerWith(
			record,
			runner,
			memoryRegistry(record),
			attachDeps(async () =>
				hostAttachment(async () => ({
					stdout: "",
					stderr: "pane still owned",
					exitCode: 1,
					timedOut: false,
				})),
			),
		);
		await manager.spawn({ task: "Work.", agent: "worker" });
		markIdleFlushed(registry, sessionPath);
		expect(await manager.attach(CHILD_ID)).toMatchObject({ host: "herdr" });
		expect(await manager.restoreRpc(CHILD_ID)).toMatchObject({
			operation: "restore_rpc",
			reason: "pane still owned",
		});
		expect(runner.requests).not.toContain("start_rpc");
		expect(manager.ownsHostAttachment({ host: "herdr", attachmentId: "pane-1" })).toBe(true);
	});

	test("rejects attach when the session file is not flushed", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const { manager, registry } = managerWith(
			record,
			runner,
			memoryRegistry(record),
			attachDeps(async () => hostAttachment()),
		);
		await manager.spawn({ task: "Work.", agent: "worker" });
		registry.current = { ...registry.current!, state: "idle" };

		expect(await manager.attach(CHILD_ID)).toMatchObject({
			reason: "Session has not been flushed; attach refused",
		});
		expect(runner.requests).not.toContain("close_writer");
	});

	test("attaches a busy child after the pause handshake acks", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		runner.busy = true;
		const sessionPath = await flushedSessionPath();
		const { manager, registry } = managerWith(
			record,
			runner,
			memoryRegistry(record),
			attachDeps(async () => hostAttachment()),
		);
		await manager.spawn({ task: "Work.", agent: "worker" });
		markIdleFlushed(registry, sessionPath, "running");

		const attached = manager.attach(CHILD_ID);
		await vi.waitFor(() => {
			expect(runner.requests).toContain("pause");
		});
		runner.ackPause();
		expect(await attached).toMatchObject({ child: { id: CHILD_ID, mode: "tui" } });
		expect(runner.requests).toContain("close_writer");
	});

	test("keeps RPC when a busy child does not pause in time", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		runner.busy = true;
		const sessionPath = await flushedSessionPath();
		const { manager, registry } = managerWith(record, runner, memoryRegistry(record), {
			...attachDeps(async () => hostAttachment()),
			deadlineMs: 40,
		});
		await manager.spawn({ task: "Work.", agent: "worker" });
		markIdleFlushed(registry, sessionPath, "running");

		expect(await manager.attach(CHILD_ID)).toMatchObject({
			reason: expect.stringContaining("Child did not pause before attach deadline"),
		});
		expect(runner.pauseCancelled).toBe(true);
		expect(runner.requests).not.toContain("close_writer");
		expect(runner.writerClosed).toBe(false);
	});

	test("restores RPC when host attach fails after the writer closed", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const sessionPath = await flushedSessionPath();
		const { manager, registry } = managerWith(
			record,
			runner,
			memoryRegistry(record),
			attachDeps(async () => {
				throw new Error("herdr pane failed");
			}),
		);
		await manager.spawn({ task: "Work.", agent: "worker" });
		markIdleFlushed(registry, sessionPath);

		expect(await manager.attach(CHILD_ID)).toMatchObject({
			reason: "herdr pane failed",
		});
		expect(runner.requests).toContain("close_writer");
		expect(runner.requests).toContain("start_rpc");
		expect(await manager.get(CHILD_ID)).toMatchObject({ mode: "rpc" });
		expect(await manager.send(CHILD_ID, "later")).toMatchObject({ id: CHILD_ID });
	});

	test("aborts an in-flight attach before stop serializes", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const sessionPath = await flushedSessionPath();
		let resumeAttach: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			resumeAttach = resolve;
		});
		const { manager, registry } = managerWith(
			record,
			runner,
			memoryRegistry(record),
			attachDeps(async () => {
				await blocked;
				return hostAttachment();
			}),
		);
		await manager.spawn({ task: "Work.", agent: "worker" });
		markIdleFlushed(registry, sessionPath);

		const attachPromise = manager.attach(CHILD_ID);
		await vi.waitFor(() => {
			expect(runner.writerClosed).toBe(true);
		});
		const stopped = manager.stop(CHILD_ID);
		resumeAttach?.();
		expect(await attachPromise).toMatchObject({ reason: "Attach was cancelled" });
		expect(await stopped).toMatchObject({ state: "stopped" });
	});

	test("does not detach when a pane event arrives but the TUI process is still alive", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const sessionPath = await flushedSessionPath();
		const attachment = hostAttachment();
		const { manager, registry } = managerWith(
			record,
			runner,
			memoryRegistry(record),
			attachDeps(async () => attachment),
		);
		await manager.spawn({ task: "Work.", agent: "worker" });
		markIdleFlushed(registry, sessionPath);
		expect(await manager.attach(CHILD_ID)).toMatchObject({ host: "herdr" });
		expect(await manager.inspectHost(CHILD_ID)).toMatchObject({ alive: true, known: true });
		expect(runner.requests).not.toContain("start_rpc");
		expect(manager.ownsHostAttachment({ host: "herdr", attachmentId: "pane-1" })).toBe(true);
	});

	test("restores RPC after a confirmed TUI process exit", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const sessionPath = await flushedSessionPath();
		const attachment = hostAttachment();
		const { manager, registry } = managerWith(
			record,
			runner,
			memoryRegistry(record),
			attachDeps(async () => attachment),
		);
		await manager.spawn({ task: "Work.", agent: "worker" });
		markIdleFlushed(registry, sessionPath);
		await manager.attach(CHILD_ID);
		attachment.setAlive(false);
		expect(await manager.inspectHost(CHILD_ID)).toMatchObject({ id: CHILD_ID, mode: "rpc" });
		expect(runner.requests).toContain("start_rpc");
		expect(manager.ownsHostAttachment({ host: "herdr", attachmentId: "pane-1" })).toBe(false);
	});

	test("unbinds A without closing the TUI after a confirmed session switch", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const sessionPath = await flushedSessionPath();
		let cleaned = 0;
		const attachment = hostAttachment(async () => {
			cleaned += 1;
			return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
		});
		const { manager, registry } = managerWith(
			record,
			runner,
			memoryRegistry(record),
			attachDeps(async () => attachment),
		);
		await manager.spawn({ task: "Work.", agent: "worker" });
		markIdleFlushed(registry, sessionPath);
		await manager.attach(CHILD_ID);
		runner.emit({
			type: "child_lifecycle",
			kind: "left_session",
			parentSessionId: PARENT_ID,
			childId: CHILD_ID,
			runtimeIdentity: "runtime-test",
			sessionId: "session-b",
		});
		await vi.waitFor(() => {
			expect(runner.requests).toContain("start_rpc");
		});
		expect(cleaned).toBe(0);
		expect(manager.ownsHostAttachment({ host: "herdr", attachmentId: "pane-1" })).toBe(false);
		expect(await manager.get(CHILD_ID)).toMatchObject({ mode: "rpc" });
		expect(await manager.send(CHILD_ID, "later")).toMatchObject({ id: CHILD_ID });
	});

	test("notifies the parent on a confirmed TUI interrupt without restoring RPC", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const sessionPath = await flushedSessionPath();
		const reports: Array<{ reason: string; message: string }> = [];
		const { manager, registry } = managerWith(record, runner, memoryRegistry(record), {
			...attachDeps(async () => hostAttachment()),
			channel: {
				async deliver(report) {
					reports.push({ reason: report.reason, message: report.message });
				},
			},
		});
		await manager.spawn({ task: "Work.", agent: "worker" });
		markIdleFlushed(registry, sessionPath);
		await manager.attach(CHILD_ID);
		runner.emit({
			type: "child_lifecycle",
			kind: "user_interrupt",
			parentSessionId: PARENT_ID,
			childId: CHILD_ID,
			runtimeIdentity: "runtime-test",
			sessionId: "session-test",
			message: "Task is unfinished and waiting for user intent. Last activity: editing.",
		});
		await vi.waitFor(() => {
			expect(reports).toEqual([
				{
					reason: "user_interrupt",
					message: "Task is unfinished and waiting for user intent. Last activity: editing.",
				},
			]);
		});
		expect(runner.requests).not.toContain("start_rpc");
		expect(await manager.get(CHILD_ID)).toMatchObject({
			mode: "tui",
			interrupted: "Task is unfinished and waiting for user intent. Last activity: editing.",
		});
	});

	test("does not restore a stopped child after TUI exit", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		const sessionPath = await flushedSessionPath();
		const { manager, registry } = managerWith(
			record,
			runner,
			memoryRegistry(record),
			attachDeps(async () => hostAttachment()),
		);
		await manager.spawn({ task: "Work.", agent: "worker" });
		markIdleFlushed(registry, sessionPath);
		await manager.attach(CHILD_ID);
		expect(await manager.stop(CHILD_ID)).toMatchObject({ state: "stopped" });
		expect(await manager.detach(CHILD_ID, { origin: "tui_exit" })).toMatchObject({
			reason: "Stopped child is not restored",
		});
		expect(runner.requests.filter((operation) => operation === "start_rpc")).toEqual([]);
	});

	test("mutate does not leak unhandled promise rejections when an action rejects", async () => {
		const record = childRecord("starting");
		const runner = new FakeRunner();
		let shouldFail = false;
		const baseRegistry = memoryRegistry(record);
		const originalUpdate = baseRegistry.update.bind(baseRegistry);
		const failingRegistry: ReturnType<typeof memoryRegistry> = {
			...baseRegistry,
			async update(id, expectedRevision, updater, expectedRuntimeIdentity, signal) {
				if (shouldFail) {
					throw new Error("fatal write failure");
				}
				return originalUpdate(id, expectedRevision, updater, expectedRuntimeIdentity, signal);
			},
		};
		const { manager } = managerWith(record, runner, failingRegistry);
		await manager.spawn({ task: "Work.", agent: "worker" });
		shouldFail = true;
		let unhandled = false;
		const handler = () => {
			unhandled = true;
		};
		process.once("unhandledRejection", handler);
		try {
			// Trigger an event from the runner which causes #observe -> #update to reject
			runner.emit({ type: "agent_start" });
			// Allow any microtasks / unhandled rejection turns to settle
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(unhandled).toBe(false);
		} finally {
			process.removeListener("unhandledRejection", handler);
		}
	});
});
