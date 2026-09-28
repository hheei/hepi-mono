import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
	type ChildPauseSocket,
	isConfirmedUserInterrupt,
	lastActivityText,
	registerChildBridge,
	shouldLeaveBoundSession,
} from "../src/child-bridge.js";
import { CHILD_SESSION_ENV_KEY } from "../src/domain.js";
import { PAUSE_EVENT } from "../src/protocol.js";

describe("child bridge session policy", () => {
	test("reload and same-session resume stay bound", () => {
		expect(
			shouldLeaveBoundSession({
				boundSessionId: "session-a",
				currentSessionId: "session-a",
				reason: "reload",
			}),
		).toBe(false);
		expect(
			shouldLeaveBoundSession({
				boundSessionId: "session-a",
				currentSessionId: "session-a",
				reason: "resume",
			}),
		).toBe(false);
	});

	test("new, resume, and fork of a different session leave A", () => {
		for (const reason of ["new", "resume", "fork"] as const) {
			expect(
				shouldLeaveBoundSession({
					boundSessionId: "session-a",
					currentSessionId: "session-b",
					reason,
				}),
			).toBe(true);
		}
	});

	test("only aborted assistant stops count as user interrupts", () => {
		expect(isConfirmedUserInterrupt([{ role: "assistant", stopReason: "stop" }])).toBe(false);
		expect(isConfirmedUserInterrupt([{ role: "assistant", stopReason: "error" }])).toBe(false);
		expect(isConfirmedUserInterrupt([{ role: "assistant", stopReason: "aborted" }])).toBe(true);
		expect(
			lastActivityText([{ role: "assistant", content: [{ type: "text", text: "editing files" }] }]),
		).toBe("editing files");
	});

	test("disables the identity widget and contact_parent after leaving A", () => {
		const previous = process.env;
		process.env = {
			...previous,
			PI_SUBAGENTS_PARENT_SESSION_ID: "p",
			PI_SUBAGENTS_CHILD_ID: "c",
			PI_SUBAGENTS_RUNTIME_ID: "r",
			PI_SUBAGENTS_ENDPOINT: "/x",
			PI_SUBAGENTS_TOKEN: "t",
			[CHILD_SESSION_ENV_KEY]: "session-a",
		};
		try {
			const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => void>>();
			const pi = {
				registerTool() {},
				on(event: string, handler: (event: never, ctx: ExtensionContext) => void) {
					const list = events.get(event) ?? [];
					list.push(handler);
					events.set(event, list);
					// The real API hands back an unsubscribe, which the bridge uses when it leaves.
					return () => {
						events.set(
							event,
							(events.get(event) ?? []).filter((entry) => entry !== handler),
						);
					};
				},
			} as unknown as ExtensionAPI;
			const state = registerChildBridge(
				pi,
				{
					parentSessionId: "p",
					subagentId: "c",
					runtimeIdentity: "r",
					endpoint: "/x",
					token: "t",
				},
				{ connect: async () => undefined },
			);
			expect(state.bound).toBe(true);
			const ctx = {
				mode: "rpc",
				sessionManager: { getSessionId: () => "session-b" },
			} as unknown as ExtensionContext;
			for (const handler of events.get("session_start") ?? []) {
				handler({ type: "session_start", reason: "new" } as never, ctx);
			}
			expect(state.bound).toBe(false);
		} finally {
			process.env = previous;
		}
	});

	test("holds turn_end until pause is cancelled", async () => {
		const previous = process.env;
		process.env = {
			...previous,
			PI_SUBAGENTS_PARENT_SESSION_ID: "p",
			PI_SUBAGENTS_CHILD_ID: "c",
			PI_SUBAGENTS_RUNTIME_ID: "r",
			PI_SUBAGENTS_ENDPOINT: "/x",
			PI_SUBAGENTS_TOKEN: "t",
			[CHILD_SESSION_ENV_KEY]: "session-a",
		};
		try {
			const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
			const reported: number[] = [];
			const listeners = new Set<(event: unknown) => void>();
			const pauseSocket: ChildPauseSocket = {
				async reportPaused(generation) {
					reported.push(generation);
				},
				onEvent(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				close() {},
			};
			const pi = {
				registerTool() {},
				on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
					const list = events.get(event) ?? [];
					list.push(handler);
					events.set(event, list);
				},
			} as unknown as ExtensionAPI;
			const state = registerChildBridge(
				pi,
				{
					parentSessionId: "p",
					subagentId: "c",
					runtimeIdentity: "r",
					endpoint: "/x",
					token: "t",
				},
				{ pauseSocket, connect: async () => undefined },
			);
			for (const listener of listeners) listener({ type: PAUSE_EVENT, generation: 4 });
			expect(state.gate.holding).toBe(true);
			const ctx = {
				mode: "rpc",
				sessionManager: { getSessionId: () => "session-a" },
			} as unknown as ExtensionContext;
			let finished = false;
			const held = Promise.all(
				(events.get("turn_end") ?? []).map((handler) => handler({} as never, ctx)),
			).then(() => {
				finished = true;
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(reported).toEqual([4]);
			expect(finished).toBe(false);
			state.gate.cancel(4);
			await held;
			expect(finished).toBe(true);
		} finally {
			process.env = previous;
		}
	});
});
