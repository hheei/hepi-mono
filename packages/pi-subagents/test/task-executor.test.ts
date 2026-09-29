import { TaskRegistry, type TaskTerminalEvent } from "@hheei/pi-ext-core";
import { expect, test } from "vitest";
import { AgentTaskExecutor, AgentTaskQueueError } from "../src/task-executor.js";

const CONTRACT = { softTurns: 60 };

/** Lets the executor's async phase transitions finish before asserting on them. */
function flush(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}
const SETTLED = { type: "agent_settled" };

interface Harness {
	readonly registry: TaskRegistry;
	readonly executor: AgentTaskExecutor;
	readonly launches: string[];
	readonly stops: string[];
	/** Children whose stop is not confirmed yet. */
	readonly unconfirmed: Set<string>;
	readonly failures: string[];
	readonly terminals: TaskTerminalEvent[];
	resolveLaunch(childId?: string): void;
	failLaunch(reason: string): void;
}

function harness(options: { maxRunning?: number; maxQueued?: number } = {}): Harness {
	const registry = new TaskRegistry({ runtimeDiscriminator: "test" });
	const launches: string[] = [];
	const stops: string[] = [];
	const unconfirmed = new Set<string>();
	const failures: string[] = [];
	const terminals: TaskTerminalEvent[] = [];
	registry.onTerminal((event) => terminals.push(event));
	// One entry per in-flight launch: several Tasks can be starting at the same time.
	const pending: Array<{
		resolve: (childId: string) => void;
		reject: (error: Error) => void;
		entry: { done: boolean };
	}> = [];
	let counter = 0;
	const executor = new AgentTaskExecutor({
		registry,
		...(options.maxRunning === undefined ? {} : { maxRunning: options.maxRunning }),
		...(options.maxQueued === undefined ? {} : { maxQueued: options.maxQueued }),
		launch(request) {
			launches.push(request.task);
			counter += 1;
			const childId = `child-${counter}`;
			return new Promise((resolve, reject) => {
				const entry = { done: false };
				const settle = (id: string): void => {
					if (entry.done) return;
					entry.done = true;
					resolve({ childId: id });
				};
				pending.push({
					resolve: (id) => settle(id ?? childId),
					reject: (error) => {
						if (entry.done) return;
						entry.done = true;
						reject(error);
					},
					entry,
				});
				// Auto-confirm the launch so a test that does not care about startup timing still
				// observes the running phase.
				queueMicrotask(() => settle(childId));
			});
		},
		async stopChild(childId) {
			stops.push(childId);
			return !unconfirmed.has(childId);
		},
		onCleanupFailure(childId, reason) {
			failures.push(`${childId}: ${reason}`);
		},
	});
	return {
		registry,
		executor,
		launches,
		stops,
		unconfirmed,
		failures,
		terminals,
		resolveLaunch: (childId) => pending.shift()?.resolve(childId ?? "child-x"),
		failLaunch: (reason) => pending.shift()?.reject(new Error(reason)),
	};
}

function request(task: string, agent = "scout") {
	return { agent, task, contract: CONTRACT };
}

test("a submitted result is the only thing that completes a task", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("find the callers"));
	await flush();
	expect(h.registry.get(task.id)?.status).toBe("running");

	h.executor.handleChildEvent("child-1", {
		type: "task_result",
		parentSessionId: "s",
		childId: "child-1",
		runtimeIdentity: "r",
		json: "done",
		structured: false,
	});
	h.executor.handleChildEvent("child-1", SETTLED);
	await flush();

	const outcome = await h.registry.wait([task.id]);
	expect(outcome[0]).toMatchObject({ status: "completed", output: "done" });
	// The dedicated child is cleaned up, so its slot is free again.
	expect(h.stops).toEqual(["child-1"]);
	expect(h.executor.running).toBe(0);
});

test("agent_end does not settle a task that has not submitted a result", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("keep working"));
	await flush();

	// `agent_end` only ends a turn; a task may still be running, so it must not complete the task
	// and must not free the slot.
	h.executor.handleChildEvent("child-1", { type: "agent_end" });
	await flush();

	expect(h.registry.get(task.id)?.status).toBe("running");
	expect(h.executor.running).toBe(1);
	expect(h.stops).toEqual([]);
});

test("a settled execution without a submission fails instead of waking the child again", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("answer without submitting"));
	await flush();

	h.executor.handleChildEvent("child-1", SETTLED);
	await flush();

	const outcome = await h.registry.wait([task.id]);
	expect(outcome[0]).toMatchObject({ status: "failed" });
	expect(outcome[0]?.status === "failed" ? outcome[0].output : "").toMatch(/without submitting/u);
	expect(h.launches).toHaveLength(1);
	expect(h.terminals).toHaveLength(1);
});

test("a blocking task reserves no notification for the result it returns itself", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start({ ...request("blocking work"), inlineResult: true });
	await flush();

	h.executor.handleChildEvent("child-1", {
		type: "task_result",
		parentSessionId: "s",
		childId: "child-1",
		runtimeIdentity: "r",
		json: "done",
		structured: false,
	});
	h.executor.handleChildEvent("child-1", SETTLED);
	await flush();

	const snapshot = h.registry.get(task.id);
	expect(snapshot?.status).toBe("completed");
	// The caller returns this result in its own tool result, so the adapter must find nothing.
	expect(snapshot?.delivery).toBeUndefined();
	expect(h.registry.pendingDeliveries()).toHaveLength(0);
});

test("a malformed result event cannot become a task result", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("reject junk"));
	await flush();

	// The runner event crosses a process boundary, so a payload the producer never validated
	// must not be trusted merely because it declares the task_result type.
	for (const junk of [
		{ type: "task_result", childId: "child-1", json: 5, structured: false },
		{ type: "task_result", childId: "child-1", json: "x" },
		{ type: "task_result" },
	]) {
		h.executor.handleChildEvent("child-1", junk);
	}
	h.executor.handleChildEvent("child-1", SETTLED);
	await flush();

	const outcome = await h.registry.wait([task.id]);
	expect(outcome[0]).toMatchObject({ status: "failed" });
	expect(outcome[0]?.status === "failed" ? outcome[0].output : "").toMatch(/without submitting/u);
});

test("a foreign child cannot settle a task it does not own", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("owned work"));
	await flush();

	h.executor.handleChildEvent("someone-else", {
		type: "task_result",
		parentSessionId: "s",
		childId: "someone-else",
		runtimeIdentity: "r",
		json: "stolen",
		structured: false,
	});
	h.executor.handleChildEvent("child-1", SETTLED);
	await flush();

	const outcome = await h.registry.wait([task.id]);
	expect(outcome[0]).toMatchObject({ status: "failed" });
	expect(outcome[0]?.status === "failed" ? outcome[0].output : "").not.toContain("stolen");
});

test("a structured result reaches the parent as a validated value", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("structured"));
	await flush();

	h.executor.handleChildEvent("child-1", {
		type: "task_result",
		parentSessionId: "s",
		childId: "child-1",
		runtimeIdentity: "r",
		json: '{"count":2}',
		structured: true,
	});
	h.executor.handleChildEvent("child-1", SETTLED);
	await flush();

	const outcome = await h.registry.wait([task.id]);
	expect(outcome[0]).toMatchObject({
		status: "completed",
		output: '{"count":2}',
		structured: { count: 2 },
	});
});

test("a launch failure settles the task instead of leaving it running forever", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("never starts"));
	h.failLaunch("no such agent");
	await flush();

	const outcome = await h.registry.wait([task.id]);
	expect(outcome[0]).toMatchObject({ status: "failed" });
	expect(h.executor.running).toBe(0);
});

test("a queued task is cancelled without ever starting a process", async (): Promise<void> => {
	const h = harness({ maxRunning: 1 });
	const first = h.executor.start(request("first"));
	const second = h.executor.start(request("second"));
	await flush();
	expect(h.registry.get(second.id)?.status).toBe("queued");

	h.registry.stop([second.id]);
	await flush();

	expect(h.registry.get(second.id)?.status).toBe("cancelled");
	expect(h.launches).toEqual(["first"]);
	h.executor.handleChildEvent("child-1", {
		type: "task_result",
		parentSessionId: "s",
		childId: "child-1",
		runtimeIdentity: "r",
		json: "first",
		structured: false,
	});
	h.executor.handleChildEvent("child-1", SETTLED);
	await flush();
	await flush();
	expect((await h.registry.wait([first.id]))[0]).toMatchObject({ status: "completed" });
});

test("a stop that arrives while the child is starting cleans up the late runner", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("stop during start"));
	h.registry.stop([task.id]);
	// The child appears only after the stop request, which is the interesting ordering.
	h.resolveLaunch("child-1");
	await flush();

	expect(h.stops).toEqual(["child-1"]);
	expect(h.registry.get(task.id)?.status).toBe("cancelled");
});

test("a stop during startup keeps the slot until the late child is confirmed gone", async (): Promise<void> => {
	const h = harness({ maxRunning: 1 });
	const first = h.executor.start(request("starting"));
	const second = h.executor.start(request("waiting"));
	h.registry.stop([first.id]);

	// The launch is still in flight, so nothing is confirmed gone: the queued task must not take
	// the slot a possibly-live child still occupies.
	expect(h.launches).toEqual(["starting"]);
	expect(h.executor.queued).toBe(1);
	expect(h.registry.get(first.id)?.status).not.toBe("cancelled");

	h.resolveLaunch("child-1");
	await flush();
	await flush();

	expect(h.stops).toEqual(["child-1"]);
	expect(h.registry.get(first.id)?.status).toBe("cancelled");
	expect(h.launches).toEqual(["starting", "waiting"]);
	expect(h.registry.get(second.id)?.status).toBe("running");
});

test("a launch that fails after a stop request is reported as cancelled", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("stop then fail"));
	h.registry.stop([task.id]);
	h.failLaunch("no such agent");
	await flush();

	expect((await h.registry.wait([task.id]))[0]).toMatchObject({ status: "cancelled" });
	expect(h.executor.running).toBe(0);
});

test("a result that arrives while its child is still starting is not lost", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("fast child"));

	// Launch resolves only after the child acknowledged its prompt, so a fast child can submit and
	// settle before the producer knows its id; those events must still reach the task.
	h.executor.handleChildEvent("child-1", {
		type: "task_result",
		parentSessionId: "s",
		childId: "child-1",
		runtimeIdentity: "r",
		json: "early",
		structured: false,
	});
	h.executor.handleChildEvent("child-1", SETTLED);
	await flush();

	expect((await h.registry.wait([task.id]))[0]).toMatchObject({
		status: "completed",
		output: "early",
	});
	expect(h.stops).toEqual(["child-1"]);
});

test("a stop that races a submitted result reports the work that was delivered", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("race"));
	h.executor.handleChildEvent("child-1", {
		type: "task_result",
		parentSessionId: "s",
		childId: "child-1",
		runtimeIdentity: "r",
		json: "early",
		structured: false,
	});
	h.registry.stop([task.id]);
	h.resolveLaunch("child-1");
	await flush();
	await flush();

	// Both paths describe the same outcome, so the race cannot decide whether delivered work looks
	// like it was thrown away.
	expect((await h.registry.wait([task.id]))[0]).toMatchObject({
		status: "completed",
		output: "early",
	});
});

test("a stop whose exit is not confirmed can be retried", async (): Promise<void> => {
	const h = harness();
	h.unconfirmed.add("child-1");
	const task = h.executor.start(request("stubborn"));
	await flush();

	h.registry.stop([task.id]);
	await flush();
	expect(h.stops).toEqual(["child-1"]);
	expect(h.failures).toHaveLength(1);
	// Unconfirmed means unconfirmed, not final: the slot stays occupied but cleanup may be retried.
	expect(h.registry.get(task.id)?.status).not.toBe("cancelled");

	h.unconfirmed.delete("child-1");
	h.registry.stop([task.id]);
	await flush();
	expect(h.stops).toEqual(["child-1", "child-1"]);
	expect(h.registry.get(task.id)?.status).toBe("cancelled");
	expect(h.executor.running).toBe(0);
});

test("an unconfirmed runner exit keeps the task active and the slot occupied", async (): Promise<void> => {
	const h = harness({ maxRunning: 1 });
	h.unconfirmed.add("child-1");
	const task = h.executor.start(request("cannot be stopped"));
	await flush();
	h.registry.stop([task.id]);
	await flush();

	// Cancellation is a request until the exit is confirmed.
	expect(h.registry.get(task.id)?.status).not.toBe("cancelled");
	expect(h.failures).toHaveLength(1);

	// The unconfirmed child still occupies the only execution slot, exactly one.
	expect(h.executor.running).toBe(1);
	h.executor.start(request("queued behind it"));
	await flush();
	expect(h.launches).toEqual(["cannot be stopped"]);
	expect(h.executor.queued).toBe(1);
});

test("a full queue is reported at admission", (): void => {
	const h = harness({ maxRunning: 1, maxQueued: 1 });
	h.executor.start(request("running"));
	h.executor.start(request("queued"));
	expect(() => h.executor.start(request("overflow"))).toThrow(AgentTaskQueueError);
});

test("chatter after a submitted result cannot push the result out of the buffer", async (): Promise<void> => {
	const h = harness();
	const task = h.executor.start(request("early result"));

	// The child submits before the producer knows its id, then keeps emitting turn traffic. A buffer
	// that evicts oldest-first would drop the submission and report a missing result instead.
	h.executor.handleChildEvent("child-1", {
		type: "task_result",
		parentSessionId: "s",
		childId: "child-1",
		runtimeIdentity: "r",
		json: "submitted early",
		structured: false,
	});
	for (let index = 0; index < 70; index += 1) {
		h.executor.handleChildEvent("child-1", { type: "turn_end", round: index });
	}
	h.executor.handleChildEvent("child-1", SETTLED);
	await flush();
	await flush();

	expect((await h.registry.wait([task.id]))[0]).toMatchObject({
		status: "completed",
		output: "submitted early",
	});
});

test("one starting child's chatter cannot push another child's settlement out", async (): Promise<void> => {
	const h = harness({ maxRunning: 2 });
	const chatty = h.executor.start(request("chatty child"));
	const quiet = h.executor.start(request("quiet child"));

	// Both launches are in flight, so neither child id is attributable yet. The first child floods
	// the buffer with turn traffic while the second one submits and settles.
	for (let index = 0; index < 70; index += 1) {
		h.executor.handleChildEvent("child-1", { type: "turn_end", round: index });
	}
	h.executor.handleChildEvent("child-2", {
		type: "task_result",
		parentSessionId: "s",
		childId: "child-2",
		runtimeIdentity: "r",
		json: "quiet result",
		structured: false,
	});
	h.executor.handleChildEvent("child-2", SETTLED);
	await flush();
	await flush();
	await flush();

	expect((await h.registry.wait([quiet.id]))[0]).toMatchObject({
		status: "completed",
		output: "quiet result",
	});
	expect(h.registry.get(chatty.id)?.status).toBe("running");
});
