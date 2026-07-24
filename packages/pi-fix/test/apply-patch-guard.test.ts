import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createApplyPatchGuardSettingsProvider,
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

function harness(toolNames: readonly string[] = []) {
	const handlers = new Map<string, Handler>();
	const messages: Array<{ readonly content: unknown; readonly options: unknown }> = [];
	let aborts = 0;
	const guard = registerApplyPatchGuard({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getAllTools: () => toolNames.map((name) => ({ name })),
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
		guard,
		messages,
		update: (command: string) => update(streamEvent(command), { abort: () => aborts++ } as never),
		settle: () => settle({} as never, {} as never),
		shutdown: () => shutdown({} as never, {} as never),
		startUserRun: () => beforeStart({} as never, {} as never),
		aborts: () => aborts,
	};
}

describe("apply_patch guard", () => {
	test("detects apply_patch after a shell separator without matching mentions", () => {
		expect(
			hasStreamingApplyPatchCommand("mkdir -p docs/plans/advisor && apply_patch <<'PATCH'"),
		).toBe(true);
		expect(hasStreamingApplyPatchCommand("rg apply_patch packages")).toBe(false);
		expect(hasStreamingApplyPatchCommand("echo apply_patch_disabled")).toBe(false);
	});

	test("auto guards only when apply_patch is not an available tool", () => {
		const unavailable = harness(["bash", "edit", "write"]);
		unavailable.update("apply_patch ");
		expect(unavailable.aborts()).toBe(1);

		const available = harness(["bash", "apply_patch"]);
		available.update("apply_patch ");
		expect(available.aborts()).toBe(0);
	});

	test("on always guards and off never guards", () => {
		const forced = harness(["apply_patch"]);
		forced.guard.setMode("on");
		forced.update("apply_patch ");
		expect(forced.aborts()).toBe(1);

		const disabled = harness();
		disabled.guard.setMode("off");
		disabled.update("apply_patch ");
		expect(disabled.aborts()).toBe(0);
	});

	test("aborts streamed bash generation and starts guidance after settlement", () => {
		const h = harness();
		h.update("mkdir -p docs/plans/advisor && apply_patch ");
		h.update("mkdir -p docs/plans/advisor && apply_patch <<'PATCH'");

		expect(h.aborts()).toBe(1);
		expect(h.messages).toEqual([]);
		h.settle();
		h.settle();
		expect(h.messages).toEqual([
			{
				content: {
					customType: "apply-patch-guard",
					content:
						"`apply_patch` is unavailable; the call was aborted. Continue with `edit` or `write`. Do not retry `apply_patch`.",
					display: true,
				},
				options: { triggerTurn: true },
			},
		]);
	});

	test("guards once per user run and resets for the next request", () => {
		const h = harness();
		h.update("apply_patch ");
		h.settle();
		h.update("apply_patch ");
		expect(h.aborts()).toBe(1);
		h.startUserRun();
		h.update("apply_patch ");
		expect(h.aborts()).toBe(2);
	});

	test("drops pending guidance when the session shuts down", () => {
		const h = harness();
		h.update("apply_patch ");
		h.shutdown();
		h.settle();
		expect(h.aborts()).toBe(1);
		expect(h.messages).toEqual([]);
	});

	test("uses independent temporary files for concurrent saves", async () => {
		const cwd = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "guard-patch-concurrent-"));
		const h = harness();
		const provider = createApplyPatchGuardSettingsProvider(h.guard);

		await Promise.all([
			provider.storage.save({ guardPatch: { mode: "on" } }, { sessionId: "a", cwd }),
			provider.storage.save({ guardPatch: { mode: "off" } }, { sessionId: "b", cwd }),
		]);

		const entries = await readdir(join(cwd, ".pi"));
		expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
	});

	test("persists mode without discarding other Pi Basics settings", async () => {
		const cwd = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "guard-patch-"));
		await mkdir(join(cwd, ".pi"));
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ "pi-basics": { rtk: { mode: "suggest" } } }),
		);
		const h = harness();
		const provider = createApplyPatchGuardSettingsProvider(h.guard);
		await provider.storage.save({ guardPatch: { mode: "off" } }, { sessionId: "test", cwd });
		const loaded = await provider.storage.load({ sessionId: "test", cwd });
		const root: unknown = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"));

		expect(loaded).toEqual({ guardPatch: { mode: "off" } });
		expect(h.guard.getMode()).toBe("off");
		expect(root).toEqual({
			"pi-basics": { rtk: { mode: "suggest" }, guardPatch: { mode: "off" } },
		});
	});
});
