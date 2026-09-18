import { describe, expect, test, vi } from "vitest";
import type { EffectiveLaunchConfig, SubagentRecord } from "../src/domain.js";
import { createParentChannel, type RunnerLike, SubagentManager } from "../src/manager.js";
import type { SubagentRegistry } from "../src/registry.js";

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
			if (current.revision !== expectedRevision) throw new Error("stale revision");
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
	};
	return store;
}

class FakeRunner implements RunnerLike {
	public connected = true;
	public readonly requests: string[] = [];
	public rejectSend = false;
	public rejectPrompt = false;
	readonly #listeners = new Set<(event: unknown) => void>();

	public async request(operation: Parameters<RunnerLike["request"]>[0]): Promise<unknown> {
		this.requests.push(operation);
		if (this.rejectPrompt && operation === "prompt") throw new Error("connection lost");
		if (this.rejectSend && operation === "follow_up") throw new Error("connection lost");
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

function managerWith(
	record: SubagentRecord,
	runner: FakeRunner,
	registry = memoryRegistry(record),
) {
	const manager = new SubagentManager({
		parentSessionId: PARENT_ID,
		registry,
		resolve: async () => launchConfig(),
		bootstrap: async () => record,
		launch: async () => runner,
		deadlineMs: 1_000,
	});
	return { manager, registry };
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
		expect(await manager.get(CHILD_ID)).toMatchObject({ freshness: "last_known" });
		expect(await manager.list()).toEqual([expect.objectContaining({ freshness: "last_known" })]);
	});

	test("delivers only an authenticated report for the current runtime", async () => {
		const delivered = vi.fn(async () => undefined);
		const channel = createParentChannel({ deliverOnline: delivered });
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
		expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ message: "found it" }));
	});
});
