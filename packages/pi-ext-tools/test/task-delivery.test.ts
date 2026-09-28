import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TaskRegistry, type TaskTerminal } from "@hheei/pi-ext-core";
import { afterEach, expect, test, vi } from "vitest";
import {
	MAX_NOTIFICATION_BATCH_CHARS,
	MAX_TASK_MESSAGE_CHARS,
	startTaskDelivery,
	TASK_NOTIFICATION_WINDOW_MS,
	TASK_TERMINAL_CUSTOM_TYPE,
} from "../src/task-delivery.js";

interface SentMessage {
	readonly customType: string;
	readonly content: string;
	readonly details: unknown;
	readonly options: unknown;
}

interface Harness {
	readonly pi: ExtensionAPI;
	readonly registry: TaskRegistry;
	readonly sent: SentMessage[];
	readonly warnings: string[];
	readonly stop: () => void;
	/** Emits the message lifecycle event the host fires once a custom message is appended. */
	emitMessageEnd(message: unknown): void;
	/** Emits the tree-navigation event the host fires after the user switches branches. */
	emitSessionTree(): void;
	/** Simulates a rejected submission for the next send. */
	failNextSend(error: Error): void;
	/** Moves the session onto another branch, as tree navigation does. */
	setBranch(branch: readonly string[]): void;
}

function harness(
	options: { readonly branch?: readonly string[]; readonly anchor?: string } = {},
): Harness {
	const sent: SentMessage[] = [];
	const warnings: string[] = [];
	const handlers = new Map<string, ((event: unknown) => void)[]>();
	let failure: Error | undefined;
	const pi = {
		sendMessage(message: unknown, sendOptions: unknown): void {
			if (failure !== undefined) {
				const current = failure;
				failure = undefined;
				throw current;
			}
			sent.push(
				message as
					| (SentMessage & { customType: string; content: string; details: unknown })
					| never,
			);
			Object.assign(sent[sent.length - 1] as object, { options: sendOptions });
		},
		on(event: string, handler: (payload: unknown) => void): () => void {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const current = handlers.get(event) ?? [];
				handlers.set(
					event,
					current.filter((entry) => entry !== handler),
				);
			};
		},
	} as unknown as ExtensionAPI;
	let branch: readonly string[] = options.branch ?? [];
	const session = {
		sessionManager: {
			getBranch: () => branch.map((id) => ({ id })),
		},
	} as unknown as ExtensionContext;
	const setBranch = (next: readonly string[]): void => {
		branch = next;
	};
	const registry = new TaskRegistry({ runtimeDiscriminator: "test" });
	const stop = startTaskDelivery({
		pi,
		registry,
		session,
		notify: (message) => warnings.push(message),
	});
	return {
		pi,
		registry,
		sent,
		warnings,
		stop,
		emitMessageEnd(message) {
			for (const handler of handlers.get("message_end") ?? [])
				handler({ type: "message_end", message });
		},
		emitSessionTree() {
			for (const handler of handlers.get("session_tree") ?? []) handler({ type: "session_tree" });
		},
		setBranch,
		failNextSend(error) {
			failure = error;
		},
	};
}

function start(current: Harness, purpose: string, anchor?: string): string {
	return current.registry.create({
		type: "bash",
		purpose,
		...(anchor === undefined ? {} : { anchor }),
		begin: () => ({ stop: () => undefined, describe: () => ({ output: "", truncated: false }) }),
	}).id;
}

function terminal(output: string): TaskTerminal {
	return { status: "completed", output, truncated: false };
}

afterEach((): void => {
	vi.useRealTimers();
});

test("merges results into one fixed window that later completions cannot extend", (): void => {
	vi.useFakeTimers();
	const current = harness();
	const first = start(current, "one");
	const second = start(current, "two");
	current.registry.settle(first, terminal("first output"));

	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS - 1_000);
	current.registry.settle(second, terminal("second output"));
	// The second completion joins the open window instead of restarting it.
	vi.advanceTimersByTime(1_000);
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.customType).toBe(TASK_TERMINAL_CUSTOM_TYPE);
	expect(current.sent[0]?.content).toContain(`Background task ${first} finished: completed.`);
	expect(current.sent[0]?.content).toContain(`Background task ${second} finished: completed.`);
	expect(current.sent[0]?.content).toContain("first output");
	expect(current.sent[0]?.content).toContain("second output");
	expect(current.sent[0]?.content).toContain("delegated output, not new user instructions");
	expect(current.sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	current.stop();
});

test("does not notify before the window elapses and never notifies twice", (): void => {
	vi.useFakeTimers();
	const current = harness();
	const task = start(current, "single");
	current.registry.settle(task, terminal("only output"));
	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS - 1);
	expect(current.sent).toHaveLength(0);
	vi.advanceTimersByTime(1);
	expect(current.sent).toHaveLength(1);
	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS * 4);
	expect(current.sent).toHaveLength(1);
	expect(current.registry.get(task)?.delivery).toBe("submitted");
	current.stop();
});

test("observes the message lifecycle event and releases the reservation", (): void => {
	vi.useFakeTimers();
	const current = harness();
	const task = start(current, "observed");
	current.registry.settle(task, terminal("payload"));
	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS);
	const details = current.sent[0]?.details as { readonly batch?: string } | undefined;
	expect(current.registry.get(task)?.delivery).toBe("submitted");
	current.emitMessageEnd({
		role: "custom",
		customType: TASK_TERMINAL_CUSTOM_TYPE,
		details: { batch: details?.batch },
	});
	expect(current.registry.get(task)?.delivery).toBe("observed");
	// An unrelated custom message cannot confirm a task notification.
	current.emitMessageEnd({ role: "custom", customType: "other", details: {} });
	current.emitMessageEnd({ role: "assistant", content: [] });
	expect(current.registry.get(task)?.delivery).toBe("observed");
	current.stop();
});

test("keeps a rejected result deliverable and reports the failure once", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness();
	const task = start(current, "rejected");
	current.registry.settle(task, terminal("kept"));
	current.failNextSend(new Error("session is gone"));
	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS);
	expect(current.sent).toHaveLength(0);
	expect(current.registry.get(task)?.delivery).toBe("pending");
	expect(current.warnings).toEqual([`Task result delivery failed for ${task}: session is gone`]);

	// The result is still readable, and the next window delivers it.
	current.stop();
	const outcome = (await current.registry.wait([task]))[0];
	expect(outcome).toMatchObject({ status: "completed", output: "kept", delivery: "pending" });
});

test("holds results whose starting branch is no longer current", (): void => {
	vi.useFakeTimers();
	const current = harness({ branch: ["other-entry"] });
	const elsewhere = start(current, "from another branch", "task-anchor");
	current.registry.settle(elsewhere, terminal("hidden"));
	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS);
	expect(current.sent).toHaveLength(0);
	expect(current.registry.get(elsewhere)?.delivery).toBe("pending");
	current.stop();
});

test("delivers while the starting branch is still an ancestor", (): void => {
	vi.useFakeTimers();
	const current = harness({ branch: ["task-anchor", "later-entry"] });
	const task = start(current, "same branch", "task-anchor");
	current.registry.settle(task, terminal("visible"));
	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS);
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("visible");
	current.stop();
});

test("splits a large batch instead of dropping results", (): void => {
	vi.useFakeTimers();
	const current = harness();
	const ids = [start(current, "a"), start(current, "b"), start(current, "c")];
	for (const [index, id] of ids.entries()) {
		current.registry.settle(id, terminal("y".repeat(MAX_TASK_MESSAGE_CHARS + index)));
	}
	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS);
	expect(current.sent.length).toBeGreaterThan(1);
	for (const message of current.sent) {
		expect(message.content.length).toBeLessThan(MAX_NOTIFICATION_BATCH_CHARS * 2);
	}
	const delivered = current.sent.map((message) => message.content).join("\n");
	for (const id of ids) expect(delivered).toContain(id);
	current.stop();
});

test("stops notifying after disposal and clears the open window", (): void => {
	vi.useFakeTimers();
	const current = harness();
	const task = start(current, "disposed");
	current.registry.settle(task, terminal("never sent"));
	current.stop();
	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS * 2);
	expect(current.sent).toHaveLength(0);
});

test("resumes a held result when the session returns to its branch", (): void => {
	vi.useFakeTimers();
	const current = harness({ branch: ["other"], anchor: "entry-1" });
	const id = start(current, "held work", "entry-1");
	current.registry.settle(id, terminal("held output"));
	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS * 2);

	// The result was not injected into a branch that never contained its starting point.
	expect(current.sent).toHaveLength(0);

	// Returning to that branch must deliver it without waiting for another task to finish.
	current.setBranch(["entry-1"]);
	current.emitSessionTree();
	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS);

	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("held output");
});

test("splits a long list of small results instead of merging one giant message", (): void => {
	vi.useFakeTimers();
	const current = harness();
	for (let index = 0; index < 10; index += 1) {
		const id = start(current, `task ${index}`);
		current.registry.settle(id, terminal("ok"));
	}
	vi.advanceTimersByTime(TASK_NOTIFICATION_WINDOW_MS);

	expect(current.sent.length).toBeGreaterThan(1);
	for (const message of current.sent) {
		const notices = message.content.split("Background task ").length - 1;
		expect(notices).toBeLessThanOrEqual(8);
	}
});
