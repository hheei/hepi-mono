import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createStatusFeature } from "../../../src/core/contributions/status/index.js";

type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

function harness(id = "session", mode: ExtensionContext["mode"] = "tui") {
	let sessionId = id;
	const handlers = new Map<string, EventHandler[]>();
	const notifications: Array<{ message: string; level: string | undefined }> = [];
	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;
	return {
		pi,
		ctx,
		notifications,
		setSessionId(next: string) {
			sessionId = next;
		},
		emit(event: string, value: unknown, eventCtx = ctx) {
			for (const handler of handlers.get(event) ?? []) handler(value as never, eventCtx);
		},
	};
}

const runtime = (pi: ExtensionAPI, ctx: ExtensionContext) => ({
	pi,
	ctx,
	registry: {} as never,
	requestRender: () => undefined,
	close: () => undefined,
});

function assistant(
	input: number,
	output: number,
	cacheRead: number,
	reasoning?: number,
	stopReason = "stop",
): Record<string, unknown> {
	return {
		role: "assistant",
		usage: {
			input,
			output,
			cacheRead,
			...(reasoning === undefined ? {} : { reasoning }),
		},
		stopReason,
	};
}

describe("response status lifecycle", () => {
	test("prints one line per response and excludes tool waits from duration", () => {
		const h = harness();
		const feature = createStatusFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		let now = 1_000;
		const originalNow = Date.now;
		Date.now = () => now;
		try {
			h.emit("agent_start", { type: "agent_start" });
			h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: now });
			now = 3_100;
			h.emit("message_update", {
				type: "message_update",
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "first" },
			});
			now = 8_100;
			h.emit("message_end", {
				type: "message_end",
				message: assistant(654, 213, 83_000, 64),
			});
			expect(h.notifications).toEqual([
				{
					message: "↱ 654  ↳ 213  ⚇ 83K  ⏱ 2.1s  ⚡ 29.8/s",
					level: "info",
				},
			]);

			now = 50_000;
			h.emit("message_end", { type: "message_end", message: { role: "toolResult" } });
			h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: now });
			now = 55_000;
			h.emit("message_update", {
				type: "message_update",
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "first" },
			});
			now = 57_800;
			h.emit("message_end", {
				type: "message_end",
				message: assistant(475, 71, 84_000, 11),
			});
			expect(h.notifications[1]).toEqual({
				message: "↱ 475  ↳ 71  ⚇ 84K  ⏱ 5.0s  ⚡ 21.4/s",
				level: "info",
			});

			h.emit("agent_end", { type: "agent_end", messages: [] });
			h.emit("agent_settled", { type: "agent_settled" });
			expect(h.notifications).toHaveLength(2);
		} finally {
			Date.now = originalNow;
			feature.dispose("session");
		}
	});

	test("prints unknown timing and zero visible-output throughput deliberately", () => {
		const h = harness();
		const feature = createStatusFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		h.emit("agent_start", { type: "agent_start" });
		h.emit("message_end", { type: "message_end", message: assistant(500, 10, 300) });
		expect(h.notifications[0]?.message).toBe("↱ 500  ↳ 10  ⚇ 300  ⏱ ?  ⚡ ?/s");

		let now = 1_000;
		const originalNow = Date.now;
		Date.now = () => now;
		try {
			h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: now });
			h.emit("message_update", {
				type: "message_update",
				message: { role: "assistant" },
				assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
			});
			now = 1_500;
			h.emit("message_end", { type: "message_end", message: assistant(20, 0, 300, 0) });
			expect(h.notifications[1]?.message).toBe("↱ 20  ↳ 0  ⚇ 300  ⏱ ?  ⚡ ?/s");
		} finally {
			Date.now = originalNow;
			feature.dispose("session");
		}
	});

	test("ignores failed responses, stale contexts, disposed sessions, and non-TUI modes", () => {
		const h = harness();
		const feature = createStatusFeature(h.pi);
		feature.start(runtime(h.pi, h.ctx));
		h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() - 10 });
		h.emit("message_end", {
			type: "message_end",
			message: assistant(10, 1, 0, 0, "error"),
		});
		h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() - 10 });
		h.emit("message_end", {
			type: "message_end",
			message: assistant(10, 1, 0, 0, "aborted"),
		});
		expect(h.notifications).toEqual([]);

		h.setSessionId("stale");
		h.emit("message_end", { type: "message_end", message: assistant(10, 1, 0) });
		feature.dispose("session");
		h.emit("message_end", { type: "message_end", message: assistant(10, 1, 0) });
		expect(h.notifications).toEqual([]);

		const json = harness("json", "json");
		const jsonFeature = createStatusFeature(json.pi);
		jsonFeature.start(runtime(json.pi, json.ctx));
		json.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() - 10 });
		json.emit("message_end", { type: "message_end", message: assistant(10, 1, 0) });
		expect(json.notifications).toEqual([]);
	});
});
