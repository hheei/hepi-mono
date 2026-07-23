import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createApplyPatchGuardSettingsProvider,
	hasStreamingApplyPatchCommand,
	registerApplyPatchGuard,
} from "../../src/runtime/apply-patch-guard.js";

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
	if (update === undefined) throw new Error("Expected message_update handler");
	return {
		guard,
		messages,
		update: (command: string) => update(streamEvent(command), { abort: () => aborts++ } as never),
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

	test("aborts streamed bash generation and injects guidance once", () => {
		const h = harness();
		h.update("mkdir -p docs/plans/advisor && apply_patch ");
		h.update("mkdir -p docs/plans/advisor && apply_patch <<'PATCH'");

		expect(h.aborts()).toBe(1);
		expect(h.messages).toEqual([
			{
				content: {
					customType: "apply-patch-guard",
					content:
						"`apply_patch` tool is unavailable. Use `edit` for precise changes or `write` for new files/complete rewrites.",
					display: true,
				},
				options: { deliverAs: "steer", triggerTurn: true },
			},
		]);
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
