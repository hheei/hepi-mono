import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createResponseStatusFeature } from "../src/index.js";

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

function assistant(
	input: number,
	output: number,
	cacheRead: number,
	stopReason = "stop",
): Record<string, unknown> {
	return { role: "assistant", usage: { input, output, cacheRead }, stopReason };
}

describe("response status", () => {
	test("prints one line per successful response using total response duration", () => {
		const h = harness();
		const feature = createResponseStatusFeature(h.pi);
		feature.start(h.ctx);
		let now = 1_000;
		const originalNow = Date.now;
		Date.now = () => now;
		try {
			h.emit("agent_start", {});
			h.emit("turn_start", { timestamp: now });
			now = 8_100;
			h.emit("message_end", { message: assistant(654, 213, 83_000) });
			expect(h.notifications).toEqual([
				{
					message: "↱ 654  ↳ 213  ⚇ 83K  ⏱ 7.1s  ⚡ 30.0/s",
					level: "info",
				},
			]);
		} finally {
			Date.now = originalNow;
		}
	});

	test("ignores failed responses, stale contexts, disposed sessions, and non-TUI modes", () => {
		const h = harness();
		const feature = createResponseStatusFeature(h.pi);
		feature.start(h.ctx);
		h.emit("turn_start", { timestamp: Date.now() - 10 });
		h.emit("message_end", { message: assistant(10, 1, 0, "error") });
		h.emit("message_end", { message: assistant(10, 1, 0, "aborted") });
		expect(h.notifications).toEqual([]);

		h.setSessionId("stale");
		h.emit("message_end", { message: assistant(10, 1, 0) });
		feature.dispose("session");
		h.emit("message_end", { message: assistant(10, 1, 0) });
		expect(h.notifications).toEqual([]);

		const json = harness("json", "json");
		const jsonFeature = createResponseStatusFeature(json.pi);
		jsonFeature.start(json.ctx);
		json.emit("turn_start", { timestamp: Date.now() - 10 });
		json.emit("message_end", { message: assistant(10, 1, 0) });
		expect(json.notifications).toEqual([]);
	});
});
