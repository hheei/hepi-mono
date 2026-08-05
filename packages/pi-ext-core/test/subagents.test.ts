import { expect, test } from "bun:test";
import {
	configureSubagentCoordinator,
	DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
	type ExtensionLifecycleContext,
	ensureSubagentCoordinator,
	lookupSubagent,
	MAX_SUBAGENT_TRANSCRIPT_CHARS,
	registerExtensionLifecycle,
	startSubagent,
} from "../src/index.js";
import { createFakePiHost } from "./fixtures.js";

test("shares an equal first-live turn cap and rejects a conflicting cap", async () => {
	const host = createFakePiHost();
	let first: ExtensionLifecycleContext | undefined;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-first",
		start(context) {
			first = context;
			configureSubagentCoordinator(context, DEFAULT_SUBAGENT_COORDINATOR_BUDGET);
		},
	});
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-same",
		start(context) {
			configureSubagentCoordinator(context, DEFAULT_SUBAGENT_COORDINATOR_BUDGET);
			expect(() =>
				configureSubagentCoordinator(context, {
					...DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
					maxActiveTurns: 3,
				}),
			).toThrow("collision");
		},
	});

	await host.emit("session_start");
	expect(first).toBeDefined();
	await host.emit("session_shutdown");
});

test("allows a policy owner to replace a fallback budget", async () => {
	const host = createFakePiHost();
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-fallback",
		start(context) {
			ensureSubagentCoordinator(context);
		},
	});
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-policy",
		start(context) {
			configureSubagentCoordinator(context, {
				...DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
				maxActiveTurns: 3,
			});
		},
	});

	await host.emit("session_start");
	await host.emit("session_shutdown");
});

test("runs a task through the consumer-resolved child-session factory", async () => {
	const host = createFakePiHost();
	let taskResult: Promise<unknown> | undefined;
	let lifecycle: ExtensionLifecycleContext | undefined;
	let taskId: ReturnType<typeof startSubagent>["id"] | undefined;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-task-test",
		start(context) {
			lifecycle = context;
			configureSubagentCoordinator(context, {
				...DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
				maxActiveTurns: 1,
			});
			const messages: unknown[] = [];
			const task = startSubagent(context, {
				mode: "task",
				session: {
					async create() {
						const messages: unknown[] = [];
						return {
							messages,
							subscribe: () => () => undefined,
							abort: () => undefined,
							dispose: () => undefined,
							async prompt() {
								messages.push({
									role: "assistant",
									content: [{ type: "text", text: "done" }],
								} as never);
							},
						} as never;
					},
				},
				prompt: "finish",
				maxTurns: 1,
				delivery: () => undefined,
			});
			taskResult = task.result;
			taskId = task.id;
		},
	});

	await host.emit("session_start");
	expect(await taskResult).toMatchObject({ status: "completed", output: "done" });
	if (lifecycle === undefined || taskId === undefined) throw new Error("Missing task lifecycle");
	expect(lookupSubagent(lifecycle, taskId)).toBeDefined();
	await host.emit("session_shutdown");
	expect(lookupSubagent(lifecycle, taskId)).toBeUndefined();
});

test("keeps one child session across sequential conversation messages", async () => {
	const host = createFakePiHost();
	let conversation: ReturnType<typeof startSubagent> | undefined;
	let created = 0;
	let compacted = 0;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-conversation-test",
		start(context) {
			configureSubagentCoordinator(context, {
				...DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
				maxActiveTurns: 1,
			});
			const messages: unknown[] = [];
			conversation = startSubagent(context, {
				mode: "conversation",
				session: {
					async create() {
						created += 1;
						const messages: unknown[] = [];
						return {
							messages,
							subscribe: () => () => undefined,
							abort: () => undefined,
							dispose: () => undefined,
							compact: async () => {
								compacted += 1;
							},
							async prompt(message: string) {
								messages.push({
									role: "assistant",
									content: [{ type: "text", text: `reply:${message}` }],
									usage: { input: 2, output: 3, totalTokens: 5, cost: { total: 0.25 } },
								} as never);
							},
						} as never;
					},
				},
				initialMessage: "first",
				initialReply: { kind: "wait", signal: new AbortController().signal },
				fallbackDelivery: () => undefined,
				maxTurnsPerReply: 1,
			});
		},
	});

	await host.emit("session_start");
	if (conversation === undefined || conversation.mode !== "conversation")
		throw new Error("Missing conversation");
	expect(await conversation.initialReply).toMatchObject({
		status: "completed",
		output: "reply:first",
	});
	expect(
		await conversation.send("second", {
			reply: { kind: "wait", signal: new AbortController().signal },
		}),
	).toMatchObject({ status: "completed", output: "reply:second" });
	expect(created).toBe(1);
	expect(conversation.usage()).toEqual({ input: 4, output: 6, total: 10, cost: 0.5 });
	await conversation.compact();
	expect(compacted).toBe(1);
	await host.emit("session_shutdown");
});

test("steers an active conversation without enqueueing a duplicate prompt", async () => {
	const host = createFakePiHost();
	let conversation: ReturnType<typeof startSubagent> | undefined;
	let promptCalls = 0;
	let steerCalls = 0;
	let promptStartedResolve: (() => void) | undefined;
	const promptStarted = new Promise<void>((resolve) => {
		promptStartedResolve = resolve;
	});
	let promptResolve: (() => void) | undefined;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-steer-test",
		start(context) {
			configureSubagentCoordinator(context, {
				...DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
				maxActiveTurns: 1,
			});
			conversation = startSubagent(context, {
				mode: "conversation",
				session: {
					async create() {
						const messages: unknown[] = [];
						return {
							messages,
							subscribe: () => () => undefined,
							abort: () => undefined,
							dispose: () => undefined,
							async prompt() {
								promptCalls += 1;
								promptStartedResolve?.();
								await new Promise<void>((resolve) => {
									promptResolve = resolve;
								});
							},
							async steer() {
								steerCalls += 1;
							},
						} as never;
					},
				},
				initialMessage: "first",
				initialReply: { kind: "wait", signal: new AbortController().signal },
				fallbackDelivery: () => undefined,
				maxTurnsPerReply: 1,
			});
		},
	});

	await host.emit("session_start");
	if (conversation === undefined || conversation.mode !== "conversation")
		throw new Error("Missing conversation");
	await promptStarted;
	await conversation.steer("redirect");
	expect(steerCalls).toBe(1);
	expect(promptCalls).toBe(1);
	promptResolve?.();
	await expect(conversation.initialReply).resolves.toMatchObject({ status: "completed" });
	expect(promptCalls).toBe(1);
	await host.emit("session_shutdown");
});

test("cancels an active conversation reply and settles its observers", async () => {
	const host = createFakePiHost();
	let conversation: ReturnType<typeof startSubagent> | undefined;
	let promptStartedResolve: (() => void) | undefined;
	const promptStarted = new Promise<void>((resolve) => {
		promptStartedResolve = resolve;
	});
	let promptRelease: (() => void) | undefined;
	let abortCalls = 0;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-cancel-test",
		start(context) {
			configureSubagentCoordinator(context, {
				...DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
				maxActiveTurns: 1,
			});
			conversation = startSubagent(context, {
				mode: "conversation",
				session: {
					async create() {
						const messages: unknown[] = [];
						return {
							messages,
							subscribe: () => () => undefined,
							abort() {
								abortCalls += 1;
								promptRelease?.();
							},
							dispose: () => undefined,
							async prompt() {
								promptStartedResolve?.();
								await new Promise<void>((resolve) => {
									promptRelease = resolve;
								});
							},
						} as never;
					},
				},
				initialMessage: "first",
				initialReply: { kind: "wait", signal: new AbortController().signal },
				fallbackDelivery: () => undefined,
				maxTurnsPerReply: 1,
			});
		},
	});

	await host.emit("session_start");
	if (conversation === undefined || conversation.mode !== "conversation")
		throw new Error("Missing conversation");
	await promptStarted;
	conversation.cancel();
	await expect(conversation.initialReply).resolves.toMatchObject({ status: "cancelled" });
	await expect(conversation.result).resolves.toMatchObject({ status: "cancelled" });
	await Promise.resolve();
	expect(abortCalls).toBeGreaterThan(0);
	await host.emit("session_shutdown");
});

test("keeps partial output when a conversation turn fails", async () => {
	const host = createFakePiHost();
	let conversation: ReturnType<typeof startSubagent> | undefined;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-partial-output-test",
		start(context) {
			configureSubagentCoordinator(context, {
				...DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
				maxActiveTurns: 1,
			});
			conversation = startSubagent(context, {
				mode: "conversation",
				session: {
					async create() {
						const messages: unknown[] = [];
						return {
							messages,
							subscribe: () => () => undefined,
							abort: () => undefined,
							dispose: () => undefined,
							async prompt() {
								messages.push({
									role: "assistant",
									content: [{ type: "text", text: "partial answer" }],
								} as never);
								throw new Error("child failed");
							},
						} as never;
					},
				},
				initialMessage: "first",
				initialReply: { kind: "wait", signal: new AbortController().signal },
				fallbackDelivery: () => undefined,
				maxTurnsPerReply: 1,
			});
		},
	});

	await host.emit("session_start");
	if (conversation === undefined || conversation.mode !== "conversation")
		throw new Error("Missing conversation");
	await expect(conversation.initialReply).resolves.toMatchObject({
		status: "failed",
		output: "partial answer",
		failure: "child failed",
	});
	await host.emit("session_shutdown");
});

test("bounds conversation transcript snapshots", async () => {
	const host = createFakePiHost();
	let conversation: ReturnType<typeof startSubagent> | undefined;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-transcript-test",
		start(context) {
			configureSubagentCoordinator(context, {
				...DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
				maxActiveTurns: 1,
			});
			conversation = startSubagent(context, {
				mode: "conversation",
				session: {
					async create() {
						const messages: unknown[] = [];
						return {
							messages,
							subscribe: () => () => undefined,
							abort: () => undefined,
							dispose: () => undefined,
							async prompt() {
								messages.push({
									role: "assistant",
									content: [
										{ type: "text", text: "x".repeat(MAX_SUBAGENT_TRANSCRIPT_CHARS + 100) },
									],
								} as never);
							},
						} as never;
					},
				},
				initialMessage: "first",
				initialReply: { kind: "wait", signal: new AbortController().signal },
				fallbackDelivery: () => undefined,
				maxTurnsPerReply: 1,
			});
		},
	});

	await host.emit("session_start");
	if (conversation === undefined || conversation.mode !== "conversation")
		throw new Error("Missing conversation");
	await conversation.initialReply;
	const snapshot = conversation.transcript();
	expect(snapshot.truncated).toBe(true);
	expect(snapshot.entries).toHaveLength(1);
	expect(snapshot.entries[0]?.text.length).toBe(MAX_SUBAGENT_TRANSCRIPT_CHARS);
	await host.emit("session_shutdown");
});
