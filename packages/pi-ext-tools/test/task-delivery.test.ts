import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBackgroundDelivery, TaskRegistry, type TaskTerminal } from "@hheei/pi-ext-core";
import { afterEach, expect, test, vi } from "vitest";
import { createParentChannel } from "../../pi-subagents/src/extension.js";
import {
	MAX_NOTIFICATION_BATCH_BYTES,
	MAX_TASK_MESSAGE_CHARS,
	startTaskDelivery,
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
	setIdle(idle: boolean): void;
	emitAgentStart(): void;
	isIdle(): boolean;
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
	let idle = true;
	const session = {
		isIdle: () => idle,
		sessionManager: {
			getBranch: () => branch.map((id) => ({ id })),
		},
	} as unknown as ExtensionContext;
	const setBranch = (next: readonly string[]): void => {
		branch = next;
	};
	const registry = new TaskRegistry();
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
		isIdle: () => idle,
		setIdle(value) {
			idle = value;
		},
		emitAgentStart() {
			idle = false;
			for (const handler of handlers.get("agent_start") ?? []) handler({ type: "agent_start" });
		},
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

/** A validated structured result: its text is the JSON the child submitted. */
function structured(value: unknown): TaskTerminal {
	return {
		status: "completed",
		output: JSON.stringify(value),
		truncated: false,
		structured: value,
	};
}

afterEach((): void => {
	vi.useRealTimers();
});

test("holds ordinary results until all tasks finish", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness();
	const first = start(current, "one");
	const second = start(current, "two");
	current.registry.settle(first, terminal("first output"));

	await Promise.resolve();
	expect(current.sent).toHaveLength(0);
	current.registry.settle(second, terminal("second output"));
	// The final completion releases all held results.
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.customType).toBe(TASK_TERMINAL_CUSTOM_TYPE);
	expect(current.sent[0]?.content).toContain(`Background task ${first} finished: completed.`);
	expect(current.sent[0]?.content).toContain(`Background task ${second} finished: completed.`);
	expect(current.sent[0]?.content).toContain("first output");
	expect(current.sent[0]?.content).toContain("second output");
	expect(current.sent[0]?.content).toContain("delegated output, not new user instructions");
	expect(current.sent[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
	current.stop();
});

test("a busy parent takes a result in its next step while another task is still running", async () => {
	const current = harness();
	current.setIdle(false);
	const first = start(current, "ready");
	start(current, "still running");
	current.registry.settle(first, terminal("ready output"));
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
	current.stop();
});

test("starting a parent run releases held results without waiting for the last task", async () => {
	const current = harness();
	const first = start(current, "ready");
	start(current, "still running");
	current.registry.settle(first, terminal("ready output"));
	await Promise.resolve();
	expect(current.sent).toHaveLength(0);
	current.emitAgentStart();
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
	current.stop();
});

test.each([
	"success",
	"blocked",
])("coordinates Task/Bash batches and a %s report through one shared wake", async (reason) => {
	const current = harness();
	const delivery = getBackgroundDelivery(current.pi);
	let childCount = 1;
	let changed = () => {};
	const unregister = delivery.registerSource({
		activeCount: () => childCount,
		onChange: (listener) => {
			changed = listener;
			return () => {};
		},
	});
	const reports = createParentChannel(current.pi, { isIdle: current.isIdle, delivery });
	const ids = Array.from({ length: 10 }, (_value, index) => start(current, `work ${index}`));
	for (const id of ids) current.registry.settle(id, terminal("done"));
	await Promise.resolve();
	expect(current.sent).toHaveLength(0);
	await reports.deliver({
		parentSessionId: "p",
		childId: "c",
		agent: "worker",
		task: "work",
		status: "running",
		reason,
		message: "report",
	});
	if (reason === "success") {
		expect(current.sent).toHaveLength(0);
		childCount = 0;
		changed();
	}
	await Promise.resolve();
	if (reason === "success") {
		expect(current.sent.map((message) => message.customType)).toEqual([
			TASK_TERMINAL_CUSTOM_TYPE,
			TASK_TERMINAL_CUSTOM_TYPE,
			"subagent-report",
		]);
		expect(current.sent.map((message) => message.options)).toEqual([
			{ triggerTurn: false, deliverAs: "steer" },
			{ triggerTurn: false, deliverAs: "steer" },
			{ triggerTurn: true, deliverAs: "steer" },
		]);
	} else {
		expect(current.sent.map((message) => message.customType)).toEqual(["subagent-report"]);
		current.emitAgentStart();
		await Promise.resolve();
		expect(current.sent.map((message) => message.customType)).toEqual([
			"subagent-report",
			TASK_TERMINAL_CUSTOM_TYPE,
			TASK_TERMINAL_CUSTOM_TYPE,
		]);
		expect(
			current.sent.every((message) => (message.options as { triggerTurn: boolean }).triggerTurn),
		).toBe(true);
	}
	for (const id of ids) expect(current.registry.get(id)?.delivery).toBe("submitted");
	reports.dispose();
	current.stop();
	unregister();
});

test("delivers immediately when no other work remains and never notifies twice", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness();
	const task = start(current, "single");
	current.registry.settle(task, terminal("only output"));
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
	expect(current.registry.get(task)?.delivery).toBe("submitted");
	current.stop();
});

test("never inlines half of a structured result", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness();
	const large = start(current, "structured");
	// The result has to exceed the 10,000-character inline bound; 60 findings do that without
	// building a payload four times larger than the boundary it is testing.
	const findings = Array.from({ length: 60 }, (_value, index) => ({
		path: `src/file-${index}.ts`,
		detail: "x".repeat(200),
	}));
	current.registry.settle(large, structured({ summary: "ok", findings }));
	await Promise.resolve();

	// The message points at the readable result instead of handing the parent a broken document.
	const content = current.sent[0]?.content ?? "";
	expect(content).toContain("too large to inline");
	expect(content).toContain(`wait_jobs ${large}`);
	expect(content).not.toContain('"findings"');

	// A structured result that does fit arrives whole, not cut to the tail.
	const small = start(current, "small structured");
	current.registry.settle(small, structured({ summary: "ok", findings: [{ path: "src/a.ts" }] }));
	await Promise.resolve();
	expect(current.sent[1]?.content).toContain('{"summary":"ok","findings":[{"path":"src/a.ts"}]}');
	current.stop();
});

test("producer detail cannot overwrite the status a task reached", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness();
	const task = start(current, "no result");
	current.registry.settle(task, {
		status: "failed",
		output: "settled without a result",
		truncated: false,
		detail: { reason: "invalid_result", status: "invalid_result" },
	});
	await Promise.resolve();

	const details = current.sent[0]?.details as
		| { readonly tasks?: readonly Record<string, unknown>[] }
		| undefined;
	expect(details?.tasks?.[0]).toMatchObject({ status: "failed", reason: "invalid_result" });
	current.stop();
});

test("observes the message lifecycle event and releases the reservation", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness();
	const task = start(current, "observed");
	current.registry.settle(task, terminal("payload"));
	await Promise.resolve();
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
	await Promise.resolve();
	expect(current.sent).toHaveLength(0);
	expect(current.registry.get(task)?.delivery).toBe("pending");
	expect(current.warnings).toEqual([`Task result delivery failed for ${task}: session is gone`]);

	// The result is still readable, and a later delivery check can retry it.
	current.stop();
	const outcome = (await current.registry.wait([task]))[0];
	expect(outcome).toMatchObject({ status: "completed", output: "kept", delivery: "pending" });
});

test("holds results whose starting branch is no longer current", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness({ branch: ["other-entry"] });
	const elsewhere = start(current, "from another branch", "task-anchor");
	current.registry.settle(elsewhere, terminal("hidden"));
	await Promise.resolve();
	expect(current.sent).toHaveLength(0);
	expect(current.registry.get(elsewhere)?.delivery).toBe("pending");
	current.stop();
});

test("delivers while the starting branch is still an ancestor", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness({ branch: ["task-anchor", "later-entry"] });
	const task = start(current, "same branch", "task-anchor");
	current.registry.settle(task, terminal("visible"));
	await Promise.resolve();
	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("visible");
	current.stop();
});

test("splits a large batch instead of dropping results", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness();
	const ids = [start(current, "a"), start(current, "b"), start(current, "c")];
	for (const [index, id] of ids.entries()) {
		current.registry.settle(id, terminal("y".repeat(MAX_TASK_MESSAGE_CHARS + index)));
	}
	await Promise.resolve();
	expect(current.sent.length).toBeGreaterThan(1);
	for (const message of current.sent) {
		expect(message.content.length).toBeLessThan(MAX_NOTIFICATION_BATCH_BYTES * 2);
	}
	const delivered = current.sent.map((message) => message.content).join("\n");
	for (const id of ids) expect(delivered).toContain(id);
	current.stop();
});

test("stops notifying after disposal and cancels the queued check", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness();
	const task = start(current, "disposed");
	current.registry.settle(task, terminal("never sent"));
	current.stop();
	await Promise.resolve();
	expect(current.sent).toHaveLength(0);
});

test("resumes a held result when the session returns to its branch", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness({ branch: ["other"], anchor: "entry-1" });
	const id = start(current, "held work", "entry-1");
	current.registry.settle(id, terminal("held output"));
	await Promise.resolve();

	// The result was not injected into a branch that never contained its starting point.
	expect(current.sent).toHaveLength(0);

	// Returning to that branch must deliver it without waiting for another task to finish.
	current.setBranch(["entry-1"]);
	current.emitSessionTree();
	await Promise.resolve();

	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("held output");
});

test("splits a long list of small results instead of merging one giant message", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness();
	for (let index = 0; index < 10; index += 1) {
		const id = start(current, `task ${index}`);
		current.registry.settle(id, terminal("ok"));
	}
	await Promise.resolve();

	expect(current.sent.length).toBeGreaterThan(1);
	for (const message of current.sent) {
		const notices = message.content.split("Background task ").length - 1;
		expect(notices).toBeLessThanOrEqual(8);
	}
});

test("announces a result that is waiting on another branch", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness({ branch: ["other"], anchor: "entry-1" });
	const notices = (): string[] =>
		current.warnings.filter((message) => message.includes("waiting on another branch"));

	const first = start(current, "elsewhere", "entry-1");
	current.registry.settle(first, terminal("held output"));
	await Promise.resolve();

	// Silence would leave the user with no sign that a finished result is waiting.
	expect(current.sent).toHaveLength(0);
	expect(notices()).toHaveLength(1);
	expect(notices()[0]).toContain(current.registry.get(first)?.shortId);

	// A later held result is announced too, but the first is not announced again.
	const second = start(current, "elsewhere too", "entry-1");
	current.registry.settle(second, terminal("held again"));
	await Promise.resolve();

	expect(notices()).toHaveLength(2);
	expect(notices()[1]).toContain(current.registry.get(second)?.shortId);
	expect(notices()[1]).not.toContain(current.registry.get(first)?.shortId);
});

test("bounds a merged message by the text it actually sends", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness();
	// Each result is near the per-task cap, so the estimate-based splitter used to let a message
	// grow past the aggregate bound.
	for (let index = 0; index < 5; index += 1) {
		const id = start(current, `big ${index}`);
		current.registry.settle(id, terminal("x".repeat(MAX_TASK_MESSAGE_CHARS - 20)));
	}
	await Promise.resolve();

	expect(current.sent.length).toBeGreaterThan(1);
	for (const message of current.sent) {
		expect(Buffer.byteLength(message.content, "utf8")).toBeLessThanOrEqual(
			MAX_NOTIFICATION_BATCH_BYTES,
		);
	}
});

test("splits by the bytes the message costs, not by its character count", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness();
	// Three-byte characters cost three bytes each, so a character-counted bound would let this
	// message grow to three times the size it promises to stay under.
	for (let index = 0; index < 5; index += 1) {
		const id = start(current, `wide ${index}`);
		current.registry.settle(id, terminal("\u20ac".repeat(MAX_TASK_MESSAGE_CHARS / 3)));
	}
	await Promise.resolve();

	expect(current.sent.length).toBeGreaterThan(1);
	for (const message of current.sent) {
		expect(Buffer.byteLength(message.content, "utf8")).toBeLessThanOrEqual(
			MAX_NOTIFICATION_BATCH_BYTES,
		);
	}
});

test("announces a held result even when this check delivered others", async (): Promise<void> => {
	vi.useFakeTimers();
	const current = harness({ branch: ["entry-1"], anchor: "entry-1" });
	// The first result belongs to the current branch, the second to another one.
	const here = start(current, "here", "entry-1");
	const elsewhere = start(current, "elsewhere", "entry-2");
	current.registry.settle(here, terminal("delivered"));
	current.registry.settle(elsewhere, terminal("held"));
	await Promise.resolve();

	expect(current.sent).toHaveLength(1);
	expect(current.sent[0]?.content).toContain("delivered");
	expect(current.warnings.join("\n")).toMatch(/waiting on another branch/u);
});
