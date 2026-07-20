import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createGoalFeature } from "../../../src/modules/goal/feature.js";
import { createHePiRuntimeContext } from "../../../src/runtime/context.js";
import { createToolActivationCoordinator } from "../../../src/runtime/tool-activation.js";

function fixture() {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
	const tools: any[] = [];
	const commands: any[] = [];
	const entries: unknown[] = [];
	const sent: Array<{ content: string; options?: unknown }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
	let aborted = 0;
	let idle = true;
	let appendError: Error | undefined;
	const sessionManager = { getSessionId: () => "goal-session", getBranch: () => entries };
	const pi = {
		registerTool(tool: unknown) {
			tools.push(tool);
		},
		registerCommand(name: string, options: unknown) {
			commands.push({ name, ...(options as object) });
		},
		on(name: string, handler: unknown) {
			handlers.set(name, handler as any);
		},
		appendEntry(_type: string, data: unknown) {
			if (appendError) throw appendError;
			entries.push({ type: "custom", customType: "goal", data });
		},
		sendUserMessage(content: string, options?: unknown) {
			sent.push({ content, options });
		},
		getActiveTools: () => [],
		setActiveTools: () => undefined,
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp/goal",
		signal: undefined,
		sessionManager,
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			setStatus: () => undefined,
		},
		isIdle: () => idle,
		hasPendingMessages: () => false,
		abort: () => {
			aborted++;
		},
	} as unknown as ExtensionContext;
	const commandCtx = {
		...ctx,
		waitForIdle: async () => undefined,
	} as unknown as ExtensionCommandContext;
	const runtime = createHePiRuntimeContext(pi as unknown as ExtensionAPI, ctx, {} as never);
	const coordinator = createToolActivationCoordinator(pi as unknown as ExtensionAPI);
	coordinator.setLoadoutBaseline(["goal"]);
	const feature = createGoalFeature(pi as unknown as ExtensionAPI, coordinator, {
		idFactory: (() => {
			let n = 0;
			return () => `goal-${++n}`;
		})(),
		scheduler: {
			setTimeout(callback, delay) {
				const timer = { callback, delay, cancelled: false };
				timers.push(timer);
				return timer;
			},
			clearTimeout(timer) {
				const found = timers.find((candidate) => candidate === timer);
				if (found) found.cancelled = true;
			},
		},
	});
	return {
		feature,
		runtime,
		commandCtx,
		handlers,
		tools,
		commands,
		entries,
		sent,
		notifications,
		timers,
		set appendError(value: Error | undefined) {
			appendError = value;
		},
		get aborted() {
			return aborted;
		},
		set idle(value: boolean) {
			idle = value;
		},
	};
}

describe("goal feature", () => {
	test("direct command persists objective, injects context, and completes", async () => {
		const fixtureState = fixture();
		fixtureState.feature.start(fixtureState.runtime);
		await fixtureState.commands[0].handler("  ship it  ", fixtureState.commandCtx);
		expect(fixtureState.feature.getState()).toMatchObject({
			mode: "active",
			active: { goalId: "goal-1", objective: "ship it" },
		});
		expect(fixtureState.sent[0]?.content).toContain("ship it");
		const before = fixtureState.handlers.get("before_agent_start");
		const context = await before?.({ systemPrompt: "base" }, fixtureState.commandCtx);
		expect(context.systemPrompt).toContain('<goal-context goal_id="goal-1">');
		const goalTool = fixtureState.tools[0];
		const result = await goalTool.execute(
			"call",
			{ goal_id: "goal-1", status: "complete", summary: "  done  " },
			undefined,
			undefined,
			fixtureState.commandCtx,
		);
		expect(result.terminate).toBe(true);
		expect(fixtureState.feature.getState()).toEqual({ mode: "inactive" });
	});

	test("settled schedules one follow-up and stale goal id is rejected", async () => {
		const fixtureState = fixture();
		fixtureState.feature.start(fixtureState.runtime);
		await fixtureState.commands[0].handler("objective", fixtureState.commandCtx);
		await fixtureState.handlers.get("before_agent_start")?.(
			{ systemPrompt: "base" },
			fixtureState.commandCtx,
		);
		await fixtureState.handlers.get("agent_settled")?.({}, fixtureState.commandCtx);
		expect(fixtureState.timers[0]?.delay).toBe(15_000);
		fixtureState.timers[0]!.callback();
		expect(fixtureState.sent).toHaveLength(2);
		await expect(
			fixtureState.tools[0].execute(
				"call",
				{ goal_id: "old", status: "complete", summary: "done" },
				undefined,
				undefined,
				fixtureState.commandCtx,
			),
		).rejects.toThrow("stale");
	});

	test("waiting captures ordinary input and Loadout disable propagates persistence failure", async () => {
		const fixtureState = fixture();
		fixtureState.feature.start(fixtureState.runtime);
		await fixtureState.commands[0].handler("", fixtureState.commandCtx);
		const inputResult = await fixtureState.handlers.get("input")?.(
			{ text: "captured objective", source: "interactive" },
			fixtureState.commandCtx,
		);
		expect(inputResult).toEqual({ action: "continue" });
		expect(fixtureState.feature.getState()).toMatchObject({
			mode: "active",
			active: { objective: "captured objective" },
		});
		fixtureState.appendError = new Error("append failed");
		await expect(fixtureState.feature.disableFromLoadout()).rejects.toThrow("append failed");
		expect(fixtureState.feature.getState()).toMatchObject({
			mode: "active",
			active: { objective: "captured objective" },
		});
	});

	test("keeps Goal active when an error safety stop cannot persist", async () => {
		const fixtureState = fixture();
		fixtureState.feature.start(fixtureState.runtime);
		await fixtureState.commands[0].handler("objective", fixtureState.commandCtx);
		await fixtureState.handlers.get("before_agent_start")?.(
			{ systemPrompt: "base" },
			fixtureState.commandCtx,
		);
		fixtureState.appendError = new Error("append failed");
		await fixtureState.handlers.get("agent_end")?.(
			{ messages: [{ role: "assistant", stopReason: "error" }] },
			fixtureState.commandCtx,
		);
		await fixtureState.handlers.get("agent_settled")?.({}, fixtureState.commandCtx);
		expect(fixtureState.feature.getState()).toMatchObject({
			mode: "active",
			active: { objective: "objective" },
		});
		expect(fixtureState.notifications.at(-1)).toMatchObject({
			level: "error",
			message: expect.stringContaining("remains active"),
		});
	});

	test("warns and ignores malformed Goal history", () => {
		const fixtureState = fixture();
		fixtureState.entries.push({
			type: "custom",
			customType: "goal",
			data: { version: 99, kind: "snapshot", objective: "bad", status: "active" },
		});
		fixtureState.feature.start(fixtureState.runtime);
		expect(fixtureState.feature.getState()).toEqual({ mode: "inactive" });
		expect(fixtureState.notifications).toContainEqual({
			message: "Ignored 1 malformed Goal history entry.",
			level: "warning",
		});
	});

	test("reports waiting objective persistence failure", async () => {
		const fixtureState = fixture();
		fixtureState.feature.start(fixtureState.runtime);
		await fixtureState.commands[0].handler("", fixtureState.commandCtx);
		fixtureState.appendError = new Error("append failed");
		await fixtureState.handlers.get("input")?.(
			{ text: "captured objective", source: "interactive" },
			fixtureState.commandCtx,
		);
		expect(fixtureState.notifications.at(-1)).toMatchObject({
			level: "error",
			message: expect.stringContaining("retry input"),
		});
	});

	test("preserves Goal runtime when tree transition fails", async () => {
		const fixtureState = fixture();
		fixtureState.feature.start(fixtureState.runtime);
		await fixtureState.commands[0].handler("objective", fixtureState.commandCtx);
		await fixtureState.handlers.get("before_agent_start")?.(
			{ systemPrompt: "base" },
			fixtureState.commandCtx,
		);
		fixtureState.idle = false;
		await fixtureState.handlers.get("session_before_tree")?.({}, fixtureState.commandCtx);
		expect(fixtureState.aborted).toBe(1);
		fixtureState.idle = true;
		await fixtureState.handlers.get("agent_settled")?.({}, fixtureState.commandCtx);
		expect(fixtureState.timers.at(-1)?.delay).toBe(15_000);
	});

	for (const eventName of ["session_before_switch", "session_before_fork"] as const) {
		test(`preserves Goal runtime when ${eventName} transition fails`, async () => {
			const fixtureState = fixture();
			fixtureState.feature.start(fixtureState.runtime);
			await fixtureState.commands[0].handler("objective", fixtureState.commandCtx);
			await fixtureState.handlers.get("before_agent_start")?.(
				{ systemPrompt: "base" },
				fixtureState.commandCtx,
			);
			fixtureState.idle = false;
			await fixtureState.handlers.get(eventName)?.({}, fixtureState.commandCtx);
			expect(fixtureState.aborted).toBe(1);
			fixtureState.idle = true;
			await fixtureState.handlers.get("agent_settled")?.({}, fixtureState.commandCtx);
			expect(fixtureState.timers.at(-1)?.delay).toBe(15_000);
		});
	}
});
