import { expect, test } from "bun:test";
import {
	configureSubagentCoordinator,
	type ExtensionLifecycleContext,
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
			configureSubagentCoordinator(context, { maxActiveTurns: 2 });
		},
	});
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-same",
		start(context) {
			configureSubagentCoordinator(context, { maxActiveTurns: 2 });
			expect(() => configureSubagentCoordinator(context, { maxActiveTurns: 3 })).toThrow(
				"collision",
			);
		},
	});

	await host.emit("session_start");
	expect(first).toBeDefined();
	await host.emit("session_shutdown");
});

test("runs a task through the consumer-resolved child-session factory", async () => {
	const host = createFakePiHost();
	let taskResult: Promise<unknown> | undefined;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-task-test",
		start(context) {
			configureSubagentCoordinator(context, { maxActiveTurns: 1 });
			const task = startSubagent(context, {
				mode: "task",
				session: {
					async create() {
						return {
							messages: [],
							subscribe: () => () => undefined,
							abort: () => undefined,
							dispose: () => undefined,
							async prompt() {
								this.messages.push({
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
		},
	});

	await host.emit("session_start");
	expect(await taskResult).toMatchObject({ status: "completed", output: "done" });
	await host.emit("session_shutdown");
});

test("keeps one child session across sequential conversation messages", async () => {
	const host = createFakePiHost();
	let conversation: ReturnType<typeof startSubagent> | undefined;
	let created = 0;
	registerExtensionLifecycle(host.pi, {
		key: "@hheei/pi-conversation-test",
		start(context) {
			configureSubagentCoordinator(context, { maxActiveTurns: 1 });
			conversation = startSubagent(context, {
				mode: "conversation",
				session: {
					async create() {
						created += 1;
						return {
							messages: [],
							subscribe: () => () => undefined,
							abort: () => undefined,
							dispose: () => undefined,
							async prompt(message: string) {
								this.messages.push({
									role: "assistant",
									content: [{ type: "text", text: `reply:${message}` }],
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
	await host.emit("session_shutdown");
});
