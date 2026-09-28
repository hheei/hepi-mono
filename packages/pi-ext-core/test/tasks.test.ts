import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import {
	DEFAULT_MAX_PENDING_DELIVERIES,
	MAX_TASK_RESULT_CHARS,
	TaskCapacityError,
	TaskRegistry,
	TaskRegistryClosedError,
	type TaskTerminalEvent,
} from "../src/tasks.js";

const registries: TaskRegistry[] = [];

afterEach((): void => {
	for (const registry of registries.splice(0)) registry.dispose();
});

function tracked(registry: TaskRegistry): TaskRegistry {
	registries.push(registry);
	return registry;
}

function registry(options: { readonly onFirstTask?: () => void } = {}): TaskRegistry {
	return tracked(new TaskRegistry({ runtimeDiscriminator: "test", ...options }));
}

function idleBinding(): { stop(): void; describe(): { output: string; truncated: boolean } } {
	return { stop: () => undefined, describe: () => ({ output: "", truncated: false }) };
}

test("assigns per-family ids that do not repeat across registry lifetimes", (): void => {
	const first = registry();
	const a = first.create({ type: "bash", purpose: "one", begin: idleBinding });
	const b = first.create({ type: "bash", purpose: "two", begin: idleBinding });
	expect([a.id, b.id]).toEqual(["bash-test-1", "bash-test-2"]);
	expect([a.shortId, b.shortId]).toEqual(["bash-1", "bash-2"]);

	// Two real lifetimes restart the sequence but keep distinct full ids, so a control
	// entry from a previous lifetime can never address a task of the current one.
	const one = tracked(new TaskRegistry());
	const two = tracked(new TaskRegistry());
	const firstOfOne = one.create({ type: "bash", purpose: "one", begin: idleBinding });
	const firstOfTwo = two.create({ type: "bash", purpose: "two", begin: idleBinding });
	expect(firstOfOne.shortId).toBe("bash-1");
	expect(firstOfTwo.shortId).toBe("bash-1");
	expect(firstOfOne.id).not.toBe(firstOfTwo.id);
});

test("rejects admission once active and undelivered results fill the budget", (): void => {
	const tasks = registry();
	for (let index = 0; index < DEFAULT_MAX_PENDING_DELIVERIES; index += 1) {
		tasks.create({ type: "bash", purpose: `job ${index}`, begin: idleBinding });
	}
	expect(() => tasks.create({ type: "bash", purpose: "overflow", begin: idleBinding })).toThrow(
		TaskCapacityError,
	);
	// A delivered result releases its reservation, so admission recovers.
	const settled = tasks.list()[0];
	if (settled === undefined) throw new Error("expected an admitted task");
	tasks.settle(settled.id, { status: "completed", output: "done", truncated: false });
	tasks.markSubmitted([settled.id], "batch");
	expect(() =>
		tasks.create({ type: "bash", purpose: "after release", begin: idleBinding }),
	).not.toThrow();
});

test("keeps one terminal result and protects it from eviction while pending", (): void => {
	const tasks = tracked(new TaskRegistry({ runtimeDiscriminator: "test", maxRetainedTerminal: 1 }));
	const first = tasks.create({ type: "bash", purpose: "keep", begin: idleBinding });
	expect(tasks.settle(first.id, { status: "completed", output: "kept", truncated: false })).toBe(
		true,
	);
	expect(tasks.settle(first.id, { status: "failed", output: "late", truncated: false })).toBe(
		false,
	);

	// Delivered terminals age out under the retention cap, pending ones never do.
	for (let index = 0; index < 4; index += 1) {
		const later = tasks.create({ type: "bash", purpose: "ages out", begin: idleBinding });
		tasks.settle(later.id, { status: "completed", output: "x", truncated: false });
		tasks.markSubmitted([later.id], `batch-${index}`);
	}
	expect(tasks.get(first.id)?.status).toBe("completed");
	expect(tasks.list(true).length).toBeLessThanOrEqual(2);
});

test("reports one terminal event and notifies once per task", (): void => {
	const tasks = registry();
	const events: TaskTerminalEvent[] = [];
	tasks.onTerminal((event) => events.push(event));
	const task = tasks.create({ type: "bash", purpose: "notify", begin: idleBinding });
	tasks.settle(task.id, {
		status: "completed",
		output: "out",
		truncated: false,
		detail: { jobId: "job-1" },
	});
	tasks.settle(task.id, { status: "failed", output: "late", truncated: false });
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		id: "bash-test-1",
		shortId: "bash-1",
		type: "bash",
		status: "completed",
		detail: { jobId: "job-1" },
	});
	expect(tasks.pendingDeliveries()).toHaveLength(1);
});

test("a throwing terminal listener cannot break settling or later listeners", (): void => {
	const tasks = registry();
	const seen: string[] = [];
	tasks.onTerminal(() => {
		throw new Error("consumer failed");
	});
	tasks.onTerminal((event) => seen.push(event.id));
	const task = tasks.create({ type: "bash", purpose: "notify", begin: idleBinding });
	expect(tasks.settle(task.id, { status: "completed", output: "out", truncated: false })).toBe(
		true,
	);
	expect(seen).toEqual(["bash-test-1"]);
	expect(tasks.get(task.id)?.status).toBe("completed");
});

test("waits for every listed task, deduplicates ids and reports unknown ones", async (): Promise<void> => {
	const tasks = registry();
	const slow = tasks.create({ type: "bash", purpose: "slow", begin: idleBinding });
	const fast = tasks.create({ type: "bash", purpose: "fast", begin: idleBinding });
	tasks.settle(fast.id, { status: "completed", output: "fast done", truncated: false });
	const pending = tasks.wait([slow.id, fast.id, "bash-test-9", slow.id]);
	tasks.settle(slow.id, { status: "failed", output: "slow failed", truncated: false });
	const outcomes = await pending;
	expect(outcomes).toHaveLength(3);
	expect(outcomes[0]).toMatchObject({
		id: slow.id,
		status: "failed",
		waited: true,
		delivery: "pending",
		output: "slow failed",
	});
	expect(outcomes[1]).toMatchObject({ id: fast.id, status: "completed", output: "fast done" });
	expect(outcomes[2]).toEqual({ id: "bash-test-9", status: "not_found" });
});

test("cancelling a wait ends only the observation", async (): Promise<void> => {
	const tasks = registry();
	let stopped = 0;
	const task = tasks.create({
		type: "bash",
		purpose: "long build",
		begin: () => ({
			stop: () => {
				stopped += 1;
			},
			describe: () => ({ output: "partial", truncated: false }),
		}),
	});
	const controller = new AbortController();
	const pending = tasks.wait([task.id], controller.signal);
	controller.abort();
	const outcomes = await pending;
	expect(outcomes[0]).toMatchObject({ id: task.id, status: "running", waited: false });
	expect(outcomes[0]).not.toHaveProperty("delivery");
	expect(stopped).toBe(0);
	expect(tasks.activeCount).toBe(1);
});

test("stop requests once and never claims a terminal state", (): void => {
	const tasks = registry();
	let stopped = 0;
	const task = tasks.create({
		type: "bash",
		purpose: "long build",
		begin: () => ({
			stop: () => {
				stopped += 1;
			},
			describe: () => ({ output: "", truncated: false }),
		}),
	});
	expect(tasks.stop([task.id, task.id, "missing"])).toEqual([
		{ id: task.id, status: "stop_requested" },
		{ id: "missing", status: "not_found" },
	]);
	expect(stopped).toBe(1);

	// A later natural completion keeps its real outcome instead of becoming cancelled.
	tasks.settle(task.id, { status: "completed", output: "won the race", truncated: false });
	expect(tasks.stop([task.id])).toEqual([{ id: task.id, status: "already_terminal" }]);
	expect(tasks.get(task.id)?.status).toBe("completed");
});

test("records a synchronous startup failure without reserving a notification", (): void => {
	const tasks = registry();
	expect(() =>
		tasks.create({
			type: "bash",
			purpose: "cannot start",
			begin: () => {
				throw new Error("spawn failed");
			},
		}),
	).toThrow("spawn failed");
	const snapshot = tasks.list(true)[0];
	// The caller received the error inline, so there is nothing left to announce.
	expect(snapshot).toMatchObject({ status: "failed" });
	expect(snapshot).not.toHaveProperty("delivery");
	expect(tasks.pendingDeliveries()).toEqual([]);
	expect(tasks.requiresControl).toBe(false);
});

test("binds an asynchronous starter and refuses a binding for a stopped task", (): void => {
	const tasks = registry();
	const task = tasks.create({ type: "bash", purpose: "async start", initialStatus: "queued" });
	expect(tasks.get(task.id)?.status).toBe("queued");
	tasks.markStarting(task.id);
	expect(tasks.get(task.id)?.status).toBe("starting");
	tasks.markRunning(task.id);
	expect(tasks.get(task.id)?.status).toBe("running");
	// Startup reporting is one-way: a running task is never pushed back to queued.
	tasks.markStarting(task.id);
	expect(tasks.get(task.id)?.status).toBe("running");
	expect(tasks.bind(task.id, idleBinding())).toBe(true);
	// A second binding never replaces the first control surface.
	expect(tasks.bind(task.id, idleBinding())).toBe(false);

	const cancelled = tasks.create({
		type: "bash",
		purpose: "cancelled first",
		initialStatus: "starting",
	});
	tasks.settle(cancelled.id, { status: "cancelled", output: "", truncated: false });
	let lateStops = 0;
	expect(
		tasks.bind(cancelled.id, {
			stop: () => {
				lateStops += 1;
			},
			describe: () => ({ output: "", truncated: false }),
		}),
	).toBe(false);
	// The late runner is stopped immediately instead of running as an orphan.
	expect(lateStops).toBe(1);
});

test("tracks delivery state from pending to observed and requeues a failed submit", (): void => {
	const tasks = registry();
	const task = tasks.create({ type: "bash", purpose: "deliver", begin: idleBinding });
	tasks.settle(task.id, { status: "completed", output: "done", truncated: false });
	expect(tasks.get(task.id)?.delivery).toBe("pending");
	expect(tasks.pendingDeliveryCount).toBe(1);

	tasks.markSubmitted([task.id], "batch-a");
	expect(tasks.get(task.id)?.delivery).toBe("submitted");
	expect(tasks.pendingDeliveries()).toHaveLength(0);
	tasks.requeue("batch-a");
	expect(tasks.get(task.id)?.delivery).toBe("pending");

	tasks.markSubmitted([task.id], "batch-b");
	tasks.markObserved("batch-b");
	expect(tasks.get(task.id)?.delivery).toBe("observed");
	expect(tasks.requiresControl).toBe(false);
});

test("bounds stored output and marks the truncation", async (): Promise<void> => {
	const tasks = registry();
	const task = tasks.create({ type: "bash", purpose: "big", begin: idleBinding });
	tasks.settle(task.id, {
		status: "completed",
		output: "x".repeat(MAX_TASK_RESULT_CHARS + 500),
		truncated: false,
	});
	const outcome = (await tasks.wait([task.id]))[0];
	expect(outcome).toMatchObject({ status: "completed", truncated: true });
	if (outcome === undefined || outcome.status === "not_found")
		throw new Error("expected an outcome");
	expect(outcome.output).toHaveLength(MAX_TASK_RESULT_CHARS);
});

test("carries a validated structured result through wait", async (): Promise<void> => {
	const tasks = registry();
	const task = tasks.create({ type: "agent", purpose: "structured", begin: idleBinding });
	tasks.settle(task.id, {
		status: "completed",
		output: '{"answer":42}',
		truncated: false,
		structured: { answer: 42 },
	});
	const outcome = (await tasks.wait([task.id]))[0];
	expect(outcome).toMatchObject({ structured: { answer: 42 } });
});

test("reports control demand while work or notifications are outstanding", async (): Promise<void> => {
	const tasks = registry();
	const activated: number[] = [];
	const scoped = tracked(
		new TaskRegistry({ runtimeDiscriminator: "test", onFirstTask: () => activated.push(1) }),
	);
	expect(scoped.requiresControl).toBe(false);
	const task = scoped.create({ type: "bash", purpose: "first", begin: idleBinding });
	expect(activated).toHaveLength(1);
	expect(scoped.requiresControl).toBe(true);
	scoped.settle(task.id, { status: "completed", output: "done", truncated: false });
	// A pending result still needs the control tools to read it.
	expect(scoped.requiresControl).toBe(true);
	scoped.markSubmitted([task.id], "batch");
	expect(scoped.requiresControl).toBe(false);
	expect(tasks.requiresControl).toBe(false);
	await sleep(0);
});

test("disposes idempotently, stops active work and rejects new admissions", (): void => {
	const tasks = registry();
	let stopped = 0;
	tasks.create({
		type: "bash",
		purpose: "running",
		begin: () => ({
			stop: () => {
				stopped += 1;
			},
			describe: () => ({ output: "", truncated: false }),
		}),
	});
	tasks.dispose();
	tasks.dispose();
	expect(stopped).toBe(1);
	expect(tasks.closed).toBe(true);
	expect(() => tasks.create({ type: "bash", purpose: "late", begin: idleBinding })).toThrow(
		TaskRegistryClosedError,
	);
	// A late producer result is ignored instead of resurrecting the disposed session.
	expect(tasks.settle("bash-test-1", { status: "completed", output: "", truncated: false })).toBe(
		false,
	);
	expect(tasks.list(true)).toEqual([]);
});
