import { describe, expect, test } from "bun:test";
import {
	hasStreamingApplyPatchCommand,
	registerApplyPatchGuard,
} from "../src/apply-patch-guard.js";

type Handler = (event: never, context: never) => unknown;

function streamEvent(command: string): never {
	return {
		assistantMessageEvent: {
			type: "toolcall_delta",
			contentIndex: 0,
			partial: {
				content: [{ type: "toolCall", name: "bash", arguments: { command } }],
			},
		},
	} as never;
}

function harness(activeTools: readonly string[] = []) {
	const handlers = new Map<string, Handler>();
	const messages: Array<{ readonly content: unknown; readonly options: unknown }> = [];
	let aborts = 0;
	registerApplyPatchGuard({
		events: {},
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getActiveTools: () => [...activeTools],
		sendMessage: (content: unknown, options: unknown) => messages.push({ content, options }),
	} as never);
	const update = handlers.get("message_update");
	const settle = handlers.get("agent_settled");
	const shutdown = handlers.get("session_shutdown");
	const beforeStart = handlers.get("before_agent_start");
	if (
		update === undefined ||
		settle === undefined ||
		shutdown === undefined ||
		beforeStart === undefined
	)
		throw new Error("Expected apply_patch guard lifecycle handlers");
	return {
		messages,
		update: (command: string) => update(streamEvent(command), { abort: () => aborts++ } as never),
		settle: () => settle({} as never, {} as never),
		shutdown: () => shutdown({} as never, {} as never),
		startUserRun: () => beforeStart({} as never, {} as never),
		aborts: () => aborts,
	};
}

describe("apply_patch guard", () => {
	test("detects shell invocations without matching plain mentions", () => {
		expect(hasStreamingApplyPatchCommand("mkdir -p docs && apply_patch <<'PATCH'")).toBe(true);
		expect(hasStreamingApplyPatchCommand("rg apply_patch packages")).toBe(false);
		expect(hasStreamingApplyPatchCommand("echo apply_patch_disabled")).toBe(false);
	});

	test("guards only while apply_patch is inactive", () => {
		const unavailable = harness(["bash", "edit", "write"]);
		unavailable.update("apply_patch ");
		expect(unavailable.aborts()).toBe(1);

		const available = harness(["bash", "apply_patch"]);
		available.update("apply_patch ");
		expect(available.aborts()).toBe(0);
	});

	test("aborts once, then sends guidance for active replacement tools", () => {
		const h = harness(["bash", "edit"]);
		h.update("mkdir -p docs && apply_patch ");
		h.update("mkdir -p docs && apply_patch <<'PATCH'");

		expect(h.aborts()).toBe(1);
		expect(h.messages).toEqual([]);
		h.settle();
		h.settle();
		expect(h.messages).toEqual([
			{
				content: {
					customType: "apply-patch-guard",
					content:
						"`apply_patch` is unavailable; the call was aborted. Continue with `edit`. Do not retry `apply_patch`.",
					display: true,
				},
				options: { triggerTurn: true },
			},
		]);
	});

	test("does not recommend a disabled edit or write tool", () => {
		const h = harness(["bash"]);
		h.update("apply_patch ");
		h.settle();
		expect(h.messages).toEqual([
			{
				content: {
					customType: "apply-patch-guard",
					content:
						"`apply_patch` is unavailable; the call was aborted. No supported file-editing tool is active. Enable `apply_patch`, `edit`, or `write` before retrying.",
					display: true,
				},
				options: { triggerTurn: true },
			},
		]);
	});

	test("resets per user run and drops pending guidance at shutdown", () => {
		const h = harness();
		h.update("apply_patch ");
		h.settle();
		h.update("apply_patch ");
		expect(h.aborts()).toBe(1);
		h.startUserRun();
		h.update("apply_patch ");
		expect(h.aborts()).toBe(2);
		h.shutdown();
		h.settle();
		expect(h.messages).toHaveLength(1);
	});
});
