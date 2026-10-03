import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { ChildBridgeServer } from "../src/bridge-server.js";
import {
	childSessionTitle,
	isConfirmedUserInterrupt,
	lastActivityText,
	registerChildBridge,
	shouldDisposeBridge,
	shouldLeaveBoundSession,
	shouldReportTuiQuit,
} from "../src/child-bridge.js";
import type { ChildIdentity } from "../src/domain.js";
import { CHILD_AGENT_ENV_KEY, CHILD_SESSION_ENV_KEY, CHILD_TITLE_ENV_KEY } from "../src/domain.js";

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
				{ diagnose: () => {} },
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

	test("only a TUI session owns a reported quit", () => {
		expect(shouldReportTuiQuit({ reason: "quit", mode: "rpc" })).toBe(false);
		expect(shouldReportTuiQuit({ reason: "quit", mode: "tui" })).toBe(true);
		expect(shouldReportTuiQuit({ reason: "new", mode: "tui" })).toBe(false);
		expect(shouldReportTuiQuit({ reason: "reload", mode: "tui" })).toBe(false);
		// A reload replaces the extension instance, so the old client must stop dialing; anything that
		// only swaps the session (new/resume/fork) leaves the connection to the next session_start.
		expect(shouldDisposeBridge("quit")).toBe(true);
		expect(shouldDisposeBridge("reload")).toBe(true);
		for (const reason of ["new", "resume", "fork"] as const) {
			expect(shouldDisposeBridge(reason)).toBe(false);
		}
	});
});

test("stops hinting for the old task after the child leaves its session", () => {
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
		const hints: string[] = [];
		const pi = {
			registerTool() {},
			on(event: string, handler: (event: never, ctx: ExtensionContext) => void) {
				const list = events.get(event) ?? [];
				list.push(handler);
				events.set(event, list);
				return () => {
					events.set(
						event,
						(events.get(event) ?? []).filter((entry) => entry !== handler),
					);
				};
			},
			sendUserMessage(text: string) {
				hints.push(text);
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
			{ diagnose: () => {} },
		);
		const leaveCtx = {
			mode: "rpc",
			sessionManager: { getSessionId: () => "session-b" },
		} as unknown as ExtensionContext;
		for (const handler of events.get("session_start") ?? []) {
			handler({ type: "session_start", reason: "new" } as never, leaveCtx);
		}
		expect(state.bound).toBe(false);

		// Turns of the session the process serves next are not turns of this task.
		for (const handler of events.get("turn_end") ?? []) handler({} as never, leaveCtx);
		expect(hints).toEqual([]);
	} finally {
		process.env = previous;
	}
});

describe("child session title", () => {
	test("marks the session and prefers the requested title", () => {
		expect(
			childSessionTitle({
				title: "OVITO properties editor",
				subagentId: "agent-2",
				agent: "worker",
			}),
		).toBe("🤖 OVITO properties editor");
		// A blank title is the same as no title: the child names itself instead.
		expect(childSessionTitle({ title: "  ", subagentId: "agent-2", agent: "worker" })).toBe(
			"🤖 worker · agent-2",
		);
	});

	test("falls back to the agent and child id, and to the id alone", () => {
		expect(childSessionTitle({ title: undefined, subagentId: "agent-2", agent: "worker" })).toBe(
			"🤖 worker · agent-2",
		);
		expect(childSessionTitle({ title: undefined, subagentId: "agent-2", agent: "   " })).toBe(
			"🤖 agent-2",
		);
	});

	test("sets the title on the first bound session_start of the launched session", () => {
		const previous = process.env;
		process.env = {
			...previous,
			PI_SUBAGENTS_PARENT_SESSION_ID: "p",
			PI_SUBAGENTS_CHILD_ID: "agent-2",
			PI_SUBAGENTS_RUNTIME_ID: "r",
			PI_SUBAGENTS_ENDPOINT: "/x",
			PI_SUBAGENTS_TOKEN: "t",
			// The real launch always states the session it was started for, so the bridge starts bound.
			[CHILD_SESSION_ENV_KEY]: "session-a",
			[CHILD_AGENT_ENV_KEY]: "worker",
			[CHILD_TITLE_ENV_KEY]: "OVITO properties editor",
		};
		try {
			const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
			const titles: string[] = [];
			const pi = {
				registerTool() {},
				getAllTools: () => [],
				setSessionName: (name: string) => {
					titles.push(name);
				},
				on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
					const list = events.get(event) ?? [];
					list.push(handler);
					events.set(event, list);
					return () => undefined;
				},
			} as unknown as ExtensionAPI;
			registerChildBridge(
				pi,
				{
					parentSessionId: "p",
					subagentId: "agent-2",
					runtimeIdentity: "r",
					endpoint: "/x",
					token: "t",
				},
				{ diagnose: () => {} },
			);
			const ctx = {
				mode: "rpc",
				sessionManager: { getSessionId: () => "session-a" },
			} as unknown as ExtensionContext;
			for (const handler of events.get("session_start") ?? []) {
				handler({ type: "session_start", reason: "new" } as never, ctx);
				// A reload of the same session must not append the name again.
				handler({ type: "session_start", reason: "reload" } as never, ctx);
			}
			expect(titles).toEqual(["🤖 OVITO properties editor"]);
		} finally {
			process.env = previous;
		}
	});
});
describe("child bridge session switch", () => {
	test("stops dialing the parent after its session is replaced", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-subagents-child-bridge-"));
		const endpoint = join(dir, "parent.sock");
		const server = new ChildBridgeServer({
			endpoint,
			parentSessionId: "parent-1",
			authorize: () => undefined,
			handleRequest: async () => ({ ok: true }),
			diagnose: () => {},
		});
		await server.listen();
		try {
			const identity: ChildIdentity = {
				parentSessionId: "parent-1",
				subagentId: "agent-1",
				runtimeIdentity: "runtime-1",
				endpoint,
				token: "token-1",
			};
			const handlers = new Map<string, Array<(event: unknown, context: unknown) => void>>();
			const pi = new Proxy(
				{},
				{
					get: (_target, property) => {
						if (property === "on") {
							return (type: string, handler: (event: unknown, context: unknown) => void) => {
								const list = handlers.get(type) ?? [];
								list.push(handler);
								handlers.set(type, list);
								return () => {};
							};
						}
						if (property === "getAllTools") return () => [];
						return () => {};
					},
				},
			) as unknown as ExtensionAPI;
			// A headless-shaped context keeps the identity widget out of this test; the session switch
			// itself does not depend on how the child is presented.
			const context = (sessionId: string): ExtensionContext =>
				({
					mode: "rpc",
					isIdle: () => true,
					hasPendingMessages: () => false,
					abort: () => {},
					shutdown: () => {},
					sessionManager: {
						getSessionId: () => sessionId,
						getSessionFile: () => undefined,
						getEntries: () => [],
					},
				}) as unknown as ExtensionContext;
			registerChildBridge(pi, identity, { diagnose: () => {} });
			const emit = (type: string, event: unknown, ctx: ExtensionContext): void => {
				for (const handler of [...(handlers.get(type) ?? [])]) handler(event, ctx);
			};

			emit("session_start", { type: "session_start", reason: "startup" }, context("session-a"));
			await vi.waitFor(() => {
				expect(server.isConnected("agent-1")).toBe(true);
			});

			// The human resumed another session in this TUI, so this process left the delegated one.
			emit("session_start", { type: "session_start", reason: "resume" }, context("session-b"));
			await vi.waitFor(() => {
				expect(server.isConnected("agent-1")).toBe(false);
			});
			// The bridge must stay closed: reconnecting would let a parent adopt the session the human
			// is now using.
			await new Promise((resolve) => setTimeout(resolve, 700));
			expect(server.isConnected("agent-1")).toBe(false);
		} finally {
			await server.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
