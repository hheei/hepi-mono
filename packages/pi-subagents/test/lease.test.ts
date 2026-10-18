import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { EffectiveLaunchConfig, SubagentRecord } from "../src/domain.js";
import { assembleChildPrompt } from "../src/launch-spec.js";
import {
	commitLease,
	createConversationLease,
	type HostDirectory,
	type HostList,
	LEASE_EDGES,
	readHostGeneration,
	writeHostGeneration,
} from "../src/lease.js";
import type { ParentChannelReport } from "../src/manager.js";
import { SubagentManager } from "../src/manager.js";
import { holdProcessLock, processLockPath } from "../src/process-lock.js";
import { createSubagentRegistry, SubagentRegistryError } from "../src/registry.js";
import { withTempDir } from "./helpers/tmp-dir.js";

const PARENT = "01J7-parent";

function launchConfig(subagentId: string, cwd: string): EffectiveLaunchConfig {
	return {
		subagentId,
		invocation: { command: "/usr/bin/node", args: ["/usr/lib/pi/cli.js"] },
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
		mcp: { enabled: true },
		prompt: assembleChildPrompt("Do the work."),
		bridgeExtensionPath: "/pkg/dist/extension.js",
	};
}

function record(
	subagentId: string,
	cwd: string,
	overrides: Partial<SubagentRecord> = {},
): SubagentRecord {
	const timestamp = new Date(0).toISOString();
	return {
		subagentId,
		parentSessionId: PARENT,
		revision: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
		sessionId: `${subagentId}-session`,
		cwd,
		initialTask: "Do the work.",
		intent: "active",
		state: "running",
		presentation: "panel",
		persistence: "never_flushed",
		launchConfig: launchConfig(subagentId, cwd),
		runtime: {
			runtimeIdentity: `rt-${subagentId}`,
			endpoint: "/tmp/bridge.sock",
			attachment: { kind: "panel", host: "herdr", id: `tab-${subagentId}` },
		},
		...overrides,
	};
}

function store(filePath: string) {
	return createSubagentRegistry({ parentSessionId: PARENT, filePath, now: () => new Date(1_000) });
}

function directory(
	list: HostList,
	openIds: string[] = [],
	occupied: ReadonlySet<string> = new Set(),
): HostDirectory & { readonly opens: string[] } {
	const opens: string[] = [];
	return {
		host: "herdr",
		opens,
		async list() {
			return list;
		},
		async open(child) {
			opens.push(child.subagentId);
			if (!openIds.includes(child.subagentId) && openIds.length > 0) {
				return { failure: "not opened" };
			}
			return { id: `new-${child.subagentId}` };
		},
		occupied(child) {
			return occupied.has(child.sessionId);
		},
	};
}

test("commit writes intent and attachment once, and a stale revision cannot replace the tab", async () => {
	await withTempDir("pi-subagents-lease-", async (directoryPath) => {
		const registry = store(join(directoryPath, "registry.json"));
		const cwd = join(directoryPath, "work");
		await registry.create(
			record("sa_aaaa", cwd, { runtime: undefined, presentation: "background" }),
		);
		const spawned = await commitLease(registry, "sa_aaaa", { type: "spawn-intent" });
		expect(spawned.revision).toBe(1);
		await registry.update("sa_aaaa", 1, (current) => ({
			...current,
			runtime: { runtimeIdentity: "rt", endpoint: "/tmp/bridge.sock" },
		}));
		const bound = await commitLease(registry, "sa_aaaa", {
			type: "attachment-bound",
			attachment: { kind: "panel", host: "herdr", id: "tab-1" },
		});
		expect(bound.runtime?.attachment).toEqual({ kind: "panel", host: "herdr", id: "tab-1" });
		const again = await commitLease(registry, "sa_aaaa", {
			type: "attachment-bound",
			attachment: { kind: "panel", host: "herdr", id: "tab-2" },
		});
		expect(again.revision).toBe(bound.revision);
		expect(again.runtime?.attachment).toEqual({ kind: "panel", host: "herdr", id: "tab-1" });
		await expect(
			commitLease(registry, "sa_aaaa", { type: "stop-intent" }, bound.revision - 1),
		).rejects.toBeInstanceOf(SubagentRegistryError);
		expect((await registry.get("sa_aaaa"))?.runtime?.attachment).toEqual({
			kind: "panel",
			host: "herdr",
			id: "tab-1",
		});
	});
});

test("cancel is not a lease edge, and left-session clears the attachment without a second write", async () => {
	expect(LEASE_EDGES).toEqual([
		"spawn-intent",
		"runtime-bound",
		"attachment-bound",
		"stop-intent",
		"runtime-gone",
		"left-session",
	]);
	await withTempDir("pi-subagents-lease-", async (directoryPath) => {
		const registry = store(join(directoryPath, "registry.json"));
		await registry.create(record("sa_aaaa", join(directoryPath, "work")));
		const left = await commitLease(registry, "sa_aaaa", { type: "left-session" });
		expect(left.runtime).toBeUndefined();
		expect(left.intent).toBe("active");
		const repeat = await commitLease(registry, "sa_aaaa", { type: "left-session" });
		expect(repeat.revision).toBe(left.revision);
		const stopped = await commitLease(registry, "sa_aaaa", { type: "stop-intent" });
		const gone = await commitLease(registry, "sa_aaaa", { type: "runtime-gone" });
		expect(stopped.intent).toBe("stopped");
		expect(gone.revision).toBe(stopped.revision);
	});
});

test("reload rebinds a live tab without writing, and fork does not copy the old ledger", async () => {
	await withTempDir("pi-subagents-lease-", async (directoryPath) => {
		const path = join(directoryPath, "registry.json");
		const registry = store(path);
		await registry.create(record("sa_aaaa", join(directoryPath, "work")));
		await writeHostGeneration(path, PARENT, "gen-1");
		const before = await registry.get("sa_aaaa");
		const hosts = directory({
			known: true,
			generation: "gen-1",
			present: new Set(["tab-sa_aaaa"]),
		});
		const ready = await createConversationLease({
			registry,
			hosts,
			processes: { alive: () => false },
		}).ready();
		expect(ready).toEqual({
			ok: true,
			rebound: ["sa_aaaa"],
			rehydrated: [],
			stopped: [],
			released: [],
		});
		expect(hosts.opens).toEqual([]);
		expect(await registry.get("sa_aaaa")).toEqual(before);
		expect(await readHostGeneration(path, PARENT)).toBe("gen-1");

		const forked = store(join(directoryPath, "fork.json"));
		expect(await forked.list()).toEqual([]);
		expect((await registry.get("sa_aaaa"))?.runtime?.attachment).toEqual({
			kind: "panel",
			host: "herdr",
			id: "tab-sa_aaaa",
		});
	});
});

test("a new host generation reopens panels that were still attached, and not stopped ones", async () => {
	await withTempDir("pi-subagents-lease-", async (directoryPath) => {
		const path = join(directoryPath, "registry.json");
		const registry = store(path);
		const cwd = join(directoryPath, "work");
		await registry.create(record("sa_run", cwd));
		await registry.create(record("sa_idle", cwd, { state: "done" }));
		await registry.create(
			record("sa_stop", cwd, {
				intent: "stopped",
				state: "done",
			}),
		);
		await writeHostGeneration(path, PARENT, "gen-1");
		const hosts = directory({ known: true, generation: "gen-2", present: new Set() }, [
			"sa_run",
			"sa_idle",
		]);
		hosts.open = async (child) => {
			hosts.opens.push(child.subagentId);
			await registry.update(child.subagentId, undefined, (current) => ({
				...current,
				runtime: {
					runtimeIdentity: current.runtime?.runtimeIdentity ?? "rt",
					endpoint: current.runtime?.endpoint ?? "/tmp/bridge.sock",
				},
			}));
			return { id: `new-${child.subagentId}` };
		};
		const ready = await createConversationLease({
			registry,
			hosts,
			processes: { alive: () => false },
		}).ready();
		expect(ready.ok).toBe(true);
		expect(hosts.opens.toSorted()).toEqual(["sa_idle", "sa_run"]);
		expect((await registry.get("sa_run"))?.runtime?.attachment).toEqual({
			kind: "panel",
			host: "herdr",
			id: "new-sa_run",
		});
		expect((await registry.get("sa_stop"))?.intent).toBe("stopped");
		expect((await registry.get("sa_stop"))?.runtime?.attachment?.kind).toBe("panel");
		expect(await readHostGeneration(path, PARENT)).toBe("gen-2");
	});
});

test("an unknown host list does not open or stop anything", async () => {
	await withTempDir("pi-subagents-lease-", async (directoryPath) => {
		const path = join(directoryPath, "registry.json");
		const registry = store(path);
		await registry.create(record("sa_aaaa", join(directoryPath, "work")));
		const before = await registry.get("sa_aaaa");
		const hosts = directory({ known: false });
		const ready = await createConversationLease({
			registry,
			hosts,
			processes: { alive: () => true },
		}).ready();
		expect(ready).toEqual({ ok: false, reason: "unknown" });
		expect(hosts.opens).toEqual([]);
		expect(await registry.get("sa_aaaa")).toEqual(before);
	});
});

test("one missing tab on a live host stops only that child", async () => {
	await withTempDir("pi-subagents-lease-", async (directoryPath) => {
		const path = join(directoryPath, "registry.json");
		const registry = store(path);
		const cwd = join(directoryPath, "work");
		await registry.create(record("sa_keep", cwd));
		await registry.create(record("sa_gone", cwd));
		await writeHostGeneration(path, PARENT, "gen-1");
		const hosts = directory({
			known: true,
			generation: "gen-1",
			present: new Set(["tab-sa_keep"]),
		});
		const ready = await createConversationLease({
			registry,
			hosts,
			processes: { alive: () => false },
		}).ready();
		expect(ready).toMatchObject({ ok: true, stopped: ["sa_gone"] });
		expect(hosts.opens).toEqual([]);
		expect((await registry.get("sa_gone"))?.intent).toBe("stopped");
		expect((await registry.get("sa_gone"))?.runtime).toBeUndefined();
		expect((await registry.get("sa_keep"))?.runtime?.attachment).toEqual({
			kind: "panel",
			host: "herdr",
			id: "tab-sa_keep",
		});
	});
});

test("a child session a human already resumed is not reopened", async () => {
	await withTempDir("pi-subagents-lease-", async (directoryPath) => {
		const path = join(directoryPath, "registry.json");
		const registry = store(path);
		await registry.create(record("sa_aaaa", join(directoryPath, "work")));
		await writeHostGeneration(path, PARENT, "gen-1");
		const hosts = directory(
			{ known: true, generation: "gen-2", present: new Set() },
			[],
			new Set(["sa_aaaa-session"]),
		);
		const ready = await createConversationLease({
			registry,
			hosts,
			processes: { alive: () => false },
		}).ready();
		expect(ready).toEqual({ ok: true, rebound: [], rehydrated: [], stopped: [], released: [] });
		expect(hosts.opens).toEqual([]);
		expect((await registry.get("sa_aaaa"))?.runtime?.attachment).toEqual({
			kind: "panel",
			host: "herdr",
			id: "tab-sa_aaaa",
		});
		expect(await readHostGeneration(path, PARENT)).toBe("gen-1");
	});
});

test("a dead background pid is cleared and a live one is rebound without a new process", async () => {
	await withTempDir("pi-subagents-lease-", async (directoryPath) => {
		const path = join(directoryPath, "registry.json");
		const registry = store(path);
		const cwd = join(directoryPath, "work");
		await registry.create(
			record("sa_dead", cwd, {
				presentation: "background",
				runtime: {
					runtimeIdentity: "rt-dead",
					endpoint: "/tmp/bridge.sock",
					attachment: { kind: "process", pid: 11 },
				},
			}),
		);
		await registry.create(
			record("sa_live", cwd, {
				presentation: "background",
				runtime: {
					runtimeIdentity: "rt-live",
					endpoint: "/tmp/bridge.sock",
					attachment: { kind: "process", pid: 22 },
				},
			}),
		);
		await writeHostGeneration(path, PARENT, "gen-1");
		const hosts = directory({ known: true, generation: "gen-1", present: new Set() });
		const ready = await createConversationLease({
			registry,
			hosts,
			processes: { alive: (pid) => pid === 22 },
		}).ready();
		expect(ready).toMatchObject({ ok: true, rebound: ["sa_live"], released: ["sa_dead"] });
		expect(hosts.opens).toEqual([]);
		expect((await registry.get("sa_dead"))?.runtime).toBeUndefined();
		expect((await registry.get("sa_live"))?.runtime?.attachment).toEqual({
			kind: "process",
			pid: 22,
		});
	});
});

test("a free process lock drops the runtime even when its panel tab is still present", async () => {
	await withTempDir("pi-subagents-lease-", async (directoryPath) => {
		const path = join(directoryPath, "registry.json");
		const registry = store(path);
		const cwd = join(directoryPath, "work");
		await registry.create(record("sa_lock", cwd));
		await writeHostGeneration(path, PARENT, "gen-1");
		const lockPath = processLockPath(path, PARENT, "sa_lock");
		if (lockPath === undefined) throw new Error("lock path");
		const held = holdProcessLock(lockPath);
		const hosts = directory({
			known: true,
			generation: "gen-1",
			present: new Set(["tab-sa_lock"]),
		});
		const lease = createConversationLease({
			registry,
			hosts,
			processes: { alive: () => false },
		});
		const heldReady = await lease.ready();
		expect(heldReady).toMatchObject({ ok: true, rebound: ["sa_lock"] });
		expect((await registry.get("sa_lock"))?.runtime?.attachment?.id).toBe("tab-sa_lock");
		held.release();
		const released = await lease.ready();
		expect(released).toMatchObject({ ok: true, rebound: [], released: ["sa_lock"] });
		expect((await registry.get("sa_lock"))?.runtime).toBeUndefined();
		expect(await registry.get("sa_lock")).toMatchObject({
			state: "blocked",
			interrupted: expect.stringContaining("a send resumes it"),
		});
	});
});

test("a runtime released while this process was away is blocked and reported once", async () => {
	await withTempDir("pi-subagents-lease-", async (directoryPath) => {
		const path = join(directoryPath, "registry.json");
		const registry = store(path);
		const cwd = join(directoryPath, "work");
		await registry.create(record("sa_away", cwd));
		const lockPath = processLockPath(path, PARENT, "sa_away");
		if (lockPath === undefined) throw new Error("lock path");
		holdProcessLock(lockPath).release();
		const reports: ParentChannelReport[] = [];
		const manager = new SubagentManager({
			parentSessionId: PARENT,
			registry,
			bridge: {
				isConnected: () => false,
				disconnect() {},
				request: async () => undefined,
				onEvent: () => () => {},
				onConnectionChange: () => () => {},
			},
			resolve: async () => {
				throw new Error("unused");
			},
			bootstrap: async () => {
				throw new Error("unused");
			},
			launch: async () => {
				throw new Error("unused");
			},
			connect: async () => false,
			directory: directory({
				known: true,
				generation: "gen-1",
				present: new Set(["tab-sa_away"]),
			}),
			channel: {
				async deliver(report) {
					reports.push(report);
				},
			},
		});
		const ready = await manager.reconcile();
		expect(ready).toMatchObject({ ok: true, released: ["sa_away"], rebound: [] });
		expect((await registry.get("sa_away"))?.runtime).toBeUndefined();
		expect(await registry.get("sa_away")).toMatchObject({
			state: "blocked",
			interrupted: expect.stringContaining("a send resumes it"),
		});
		await vi.waitFor(() => {
			expect(reports.map((report) => report.reason)).toEqual(["blocked"]);
		});
		expect(reports).toHaveLength(1);
	});
});

test("runtime edges are the only way a runtime is written or removed", async () => {
	await withTempDir("pi-subagents-lease-edges-", async (directoryPath) => {
		const registry = store(join(directoryPath, "registry.json"));
		const cwd = join(directoryPath, "work");
		await registry.create(record("sa_edge", cwd, { runtime: undefined, state: "running" }));
		const bound = await commitLease(registry, "sa_edge", {
			type: "runtime-bound",
			runtimeIdentity: "rt-edge",
			endpoint: "/tmp/bridge.sock",
		});
		expect(bound.runtime).toEqual({ runtimeIdentity: "rt-edge", endpoint: "/tmp/bridge.sock" });
		const again = await commitLease(registry, "sa_edge", {
			type: "runtime-bound",
			runtimeIdentity: "rt-edge",
			endpoint: "/tmp/bridge.sock",
		});
		expect(again.revision).toBe(bound.revision);
		const dropped = await commitLease(registry, "sa_edge", {
			type: "runtime-gone",
			outcome: "drop",
		});
		expect(dropped.runtime).toBeUndefined();
		expect(dropped.state).toBe("blocked");
		const repeat = await commitLease(registry, "sa_edge", {
			type: "runtime-gone",
			outcome: "drop",
		});
		expect(repeat.revision).toBe(dropped.revision);
		await registry.update("sa_edge", repeat.revision, (current) => ({
			...current,
			state: "running",
			runtime: { runtimeIdentity: "rt-2", endpoint: "/tmp/bridge.sock" },
		}));
		await commitLease(registry, "sa_edge", { type: "stop-intent" });
		const finished = await commitLease(registry, "sa_edge", {
			type: "runtime-gone",
			outcome: "finished",
		});
		expect(finished.intent).toBe("stopped");
		expect(finished.state).toBe("done");
		expect(finished.runtime).toBeUndefined();
	});
});
