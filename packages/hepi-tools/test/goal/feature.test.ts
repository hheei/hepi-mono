import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	createHePiRuntimeContext,
	createToolActivationCoordinator,
	getToolActivationCoordinator,
} from "../../../hepi-basics/src/core/index.js";
import { replayTui, stripAnsi } from "../../../hepi-debug/src/tui-replay.js";
import { createGoalFeature } from "../../src/pi-goal/feature.js";

type TestHandler = (
	event: Record<string, unknown>,
	ctx: ExtensionCommandContext,
) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
type TestCommand = {
	name: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<unknown> | unknown;
};
type TestTool = {
	execute: (...args: unknown[]) => Promise<Record<string, unknown>>;
};
function first<T>(items: readonly T[]): T {
	const item = items[0];
	if (item === undefined) throw new Error("Expected fixture item");
	return item;
}

function fixture() {
	const handlers = new Map<string, TestHandler>();
	const tools: TestTool[] = [];
	const commands: TestCommand[] = [];
	const entries: unknown[] = [];
	const sent: Array<{ content: string; options?: unknown }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const activeSets: string[][] = [];
	const statuses = new Map<string, string | undefined>();
	const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
	let aborted = 0;
	let idle = true;
	let appendError: Error | undefined;
	const sessionManager = { getSessionId: () => "goal-session", getBranch: () => entries };
	const pi = {
		registerTool(tool: TestTool) {
			tools.push(tool);
		},
		registerCommand(name: string, options: TestCommand) {
			commands.push({ name, handler: options.handler });
		},
		on(name: string, handler: TestHandler) {
			handlers.set(name, handler);
		},
		appendEntry(_type: string, data: unknown) {
			if (appendError) throw appendError;
			entries.push({ type: "custom", customType: "goal", data });
		},
		sendUserMessage(content: string, options?: unknown) {
			sent.push({ content, options });
		},
		getActiveTools: () => [],
		setActiveTools: (names: string[]) => activeSets.push(names),
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp/goal",
		signal: undefined,
		sessionManager,
		ui: {
			notify: (message: string, level?: string) =>
				notifications.push(level === undefined ? { message } : { message, level }),
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
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
		activeSets,
		notifications,
		statuses,
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
	test("replays Goal activation across per-extension API wrappers", async () => {
		const notifications: string[] = [];
		const commands: TestCommand[] = [];
		const entries: unknown[] = [];
		const sessionManager = { getSessionId: () => "goal-replay", getBranch: () => entries };
		const events = { emit: () => undefined, on: () => () => undefined };
		const shared = {
			events,
			setActiveTools: () => undefined,
			appendEntry: (_type: string, data: unknown) => entries.push({ data }),
			sendUserMessage: () => undefined,
		};
		const loadoutApi = { ...shared } as unknown as ExtensionAPI;
		const goalApi = {
			...shared,
			on: () => undefined,
			registerTool: () => undefined,
			registerCommand: (name: string, command: TestCommand) =>
				commands.push({ name, handler: command.handler }),
		} as unknown as ExtensionAPI;
		const coordinator = getToolActivationCoordinator(loadoutApi);
		coordinator.reset();
		coordinator.setLoadoutBaseline(["goal"]);
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: "/tmp/goal-replay",
			sessionManager,
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus: () => undefined,
			},
			isIdle: () => true,
			hasPendingMessages: () => false,
			waitForIdle: async () => undefined,
		} as unknown as ExtensionCommandContext;
		const feature = createGoalFeature(goalApi, getToolActivationCoordinator(goalApi));
		await feature.start(createHePiRuntimeContext(goalApi, ctx, {} as never));
		const command = first(commands);
		const replay = await replayTui({
			create: () => ({
				render: () => [
					feature.getState().mode === "active"
						? `Goal active: ${feature.getState().active?.objective}`
						: (notifications.at(-1) ?? "Goal inactive"),
				],
				async handleInput(data: string): Promise<void> {
					await command.handler(data.replace(/^\/goal\s*/u, ""), ctx);
				},
			}),
			actions: [{ type: "text", text: "/goal diagnostic", label: "start Goal" }],
		});
		const frame = stripAnsi(replay.last.lines.join("\n"));
		expect(frame).toContain("Goal active: diagnostic");
		expect(frame).not.toContain("Goal is disabled in Loadout");
		await feature.dispose("goal-replay");
		coordinator.dispose();
	});

	test("direct command persists objective, injects context, and completes", async () => {
		const fixtureState = fixture();
		await fixtureState.feature.start(fixtureState.runtime);
		await first(fixtureState.commands).handler("  ship it  ", fixtureState.commandCtx);
		expect(fixtureState.feature.getState()).toMatchObject({
			mode: "active",
			active: { goalId: "goal-1", objective: "ship it" },
		});
		expect(fixtureState.sent[0]?.content).toBe("Start the active Goal.");
		const before = fixtureState.handlers.get("before_agent_start");
		const context = await before?.({ systemPrompt: "base" }, fixtureState.commandCtx);
		if (context === undefined) throw new Error("Expected Goal context");
		expect(context.systemPrompt).toContain('<goal-context goal_id="goal-1">');
		expect(context.systemPrompt).toContain("ship it");
		const goalTool = first(fixtureState.tools);
		const result = await goalTool.execute(
			"call",
			{ goal_id: "goal-1", status: "complete", summary: "  done  " },
			undefined,
			undefined,
			fixtureState.commandCtx,
		);
		expect(result.terminate).toBe(true);
		expect(fixtureState.feature.getState()).toEqual({ mode: "inactive" });
		expect(fixtureState.activeSets).toEqual([["goal"]]);
	});

	test("uses mode notices and one stable Goal status label", async () => {
		const fixtureState = fixture();
		await fixtureState.feature.start(fixtureState.runtime);
		expect(fixtureState.statuses.get("goal")).toBeUndefined();

		await first(fixtureState.commands).handler("", fixtureState.commandCtx);
		expect(fixtureState.statuses.get("goal")).toBe("Goal");
		await first(fixtureState.commands).handler("", fixtureState.commandCtx);
		expect(fixtureState.notifications.at(-1)?.message).toBe("※ Goal Mode stopped");
		expect(fixtureState.statuses.get("goal")).toBeUndefined();

		await first(fixtureState.commands).handler("objective", fixtureState.commandCtx);
		expect(fixtureState.notifications.at(-1)?.message).toBe("※ Goal Mode enabled");
		expect(fixtureState.statuses.get("goal")).toBe("Goal");
		await first(fixtureState.commands).handler("", fixtureState.commandCtx);
		expect(fixtureState.notifications.at(-1)?.message).toBe("※ Goal Mode stopped");
		expect(fixtureState.statuses.get("goal")).toBe("Goal");
	});

	test("keeps ordinary input outside Goal mode", async () => {
		const fixtureState = fixture();
		await fixtureState.feature.start(fixtureState.runtime);
		const inputResult = await fixtureState.handlers.get("input")?.(
			{ text: "ordinary request", source: "interactive" },
			fixtureState.commandCtx,
		);
		expect(inputResult).toBeUndefined();
		expect(fixtureState.feature.getState()).toEqual({ mode: "inactive" });
		expect(fixtureState.entries).toHaveLength(0);
		expect(fixtureState.activeSets).toEqual([["goal"]]);
		expect(
			await fixtureState.handlers.get("before_agent_start")?.(
				{ systemPrompt: "base" },
				fixtureState.commandCtx,
			),
		).toBeUndefined();
		await expect(
			first(fixtureState.tools).execute(
				"call",
				{ goal_id: "none", status: "complete", summary: "done" },
				undefined,
				undefined,
				fixtureState.commandCtx,
			),
		).rejects.toThrow("Goal is not active");
	});

	test("injects Goal instruction only while active without rewriting tools", async () => {
		const fixtureState = fixture();
		await fixtureState.feature.start(fixtureState.runtime);
		await first(fixtureState.commands).handler("objective", fixtureState.commandCtx);
		expect(fixtureState.activeSets).toEqual([["goal"]]);
		const context = await fixtureState.handlers.get("before_agent_start")?.(
			{ systemPrompt: "base" },
			fixtureState.commandCtx,
		);
		if (context === undefined || typeof context.systemPrompt !== "string")
			throw new Error("Expected Goal context");
		expect(context.systemPrompt.indexOf("Continue implementing")).toBeLessThan(
			context.systemPrompt.indexOf("Objective (untrusted user data)"),
		);
		await fixtureState.handlers.get("agent_settled")?.({}, fixtureState.commandCtx);
		expect(first(fixtureState.timers).delay).toBe(15_000);
		await fixtureState.handlers.get("input")?.(
			{ text: "supplemental request", source: "interactive" },
			fixtureState.commandCtx,
		);
		expect(fixtureState.feature.getState()).toMatchObject({
			mode: "active",
			active: { objective: "objective" },
		});
		await fixtureState.handlers.get("before_agent_start")?.(
			{ systemPrompt: "base" },
			fixtureState.commandCtx,
		);
		await fixtureState.handlers.get("agent_settled")?.({}, fixtureState.commandCtx);
		expect(first(fixtureState.timers).cancelled).toBe(true);
		expect(fixtureState.timers.at(-1)?.delay).toBe(15_000);
	});

	test("settled schedules one follow-up and stale goal id is rejected", async () => {
		const fixtureState = fixture();
		await fixtureState.feature.start(fixtureState.runtime);
		await first(fixtureState.commands).handler("objective", fixtureState.commandCtx);
		await fixtureState.handlers.get("before_agent_start")?.(
			{ systemPrompt: "base" },
			fixtureState.commandCtx,
		);
		await fixtureState.handlers.get("agent_settled")?.({}, fixtureState.commandCtx);
		expect(first(fixtureState.timers).delay).toBe(15_000);
		first(fixtureState.timers).callback();
		expect(fixtureState.sent).toHaveLength(2);
		expect(fixtureState.sent[1]?.content).toBe("Continue the active Goal.");
		await expect(
			first(fixtureState.tools).execute(
				"call",
				{ goal_id: "old", status: "complete", summary: "done" },
				undefined,
				undefined,
				fixtureState.commandCtx,
			),
		).rejects.toThrow("stale");
	});

	test("waiting captures only the next input and Loadout disable propagates persistence failure", async () => {
		const fixtureState = fixture();
		await fixtureState.feature.start(fixtureState.runtime);
		await first(fixtureState.commands).handler("", fixtureState.commandCtx);
		const inputResult = await fixtureState.handlers.get("input")?.(
			{ text: "captured objective", source: "interactive" },
			fixtureState.commandCtx,
		);
		expect(inputResult).toEqual({ action: "continue" });
		expect(fixtureState.feature.getState()).toMatchObject({
			mode: "active",
			active: { objective: "captured objective" },
		});
		expect(fixtureState.notifications.at(-1)?.message).toBe("※ Goal Mode enabled");
		expect(fixtureState.statuses.get("goal")).toBe("Goal");
		const laterInput = await fixtureState.handlers.get("input")?.(
			{ text: "later instruction", source: "interactive" },
			fixtureState.commandCtx,
		);
		expect(laterInput).toBeUndefined();
		expect(fixtureState.feature.getState()).toMatchObject({
			mode: "active",
			active: { objective: "captured objective" },
		});
		expect(fixtureState.entries).toHaveLength(1);
		fixtureState.appendError = new Error("append failed");
		await expect(fixtureState.feature.disableFromLoadout()).rejects.toThrow("append failed");
		expect(fixtureState.feature.getState()).toMatchObject({
			mode: "active",
			active: { objective: "captured objective" },
		});
	});

	test("keeps an active continuation after invalid replacement", async () => {
		const fixtureState = fixture();
		await fixtureState.feature.start(fixtureState.runtime);
		await first(fixtureState.commands).handler("objective", fixtureState.commandCtx);
		await fixtureState.handlers.get("before_agent_start")?.(
			{ systemPrompt: "base" },
			fixtureState.commandCtx,
		);
		await fixtureState.handlers.get("agent_settled")?.({}, fixtureState.commandCtx);
		await first(fixtureState.commands).handler("x".repeat(2_001), fixtureState.commandCtx);
		expect(first(fixtureState.timers).cancelled).toBe(false);
		expect(fixtureState.feature.getState()).toMatchObject({
			mode: "active",
			active: { objective: "objective" },
		});
		fixtureState.appendError = new Error("append failed");
		await first(fixtureState.commands).handler("replacement", fixtureState.commandCtx);
		expect(first(fixtureState.timers).cancelled).toBe(false);
		expect(fixtureState.feature.getState()).toMatchObject({
			mode: "active",
			active: { objective: "objective" },
		});
	});

	test("keeps Goal active when an error safety stop cannot persist", async () => {
		const fixtureState = fixture();
		await fixtureState.feature.start(fixtureState.runtime);
		await first(fixtureState.commands).handler("objective", fixtureState.commandCtx);
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

	test("warns and ignores malformed Goal history", async () => {
		const fixtureState = fixture();
		fixtureState.entries.push({
			type: "custom",
			customType: "goal",
			data: { version: 99, kind: "snapshot", objective: "bad", status: "active" },
		});
		await fixtureState.feature.start(fixtureState.runtime);
		expect(fixtureState.feature.getState()).toEqual({ mode: "inactive" });
		expect(fixtureState.notifications).toContainEqual({
			message: "Ignored 1 malformed Goal history entry.",
			level: "warning",
		});
	});

	test("exits waiting mode when objective persistence fails", async () => {
		const fixtureState = fixture();
		await fixtureState.feature.start(fixtureState.runtime);
		await first(fixtureState.commands).handler("", fixtureState.commandCtx);
		fixtureState.appendError = new Error("append failed");
		await fixtureState.handlers.get("input")?.(
			{ text: "captured objective", source: "interactive" },
			fixtureState.commandCtx,
		);
		expect(fixtureState.notifications.at(-1)).toMatchObject({
			level: "error",
			message: expect.stringContaining("run /goal again"),
		});
		const nextInput = await fixtureState.handlers.get("input")?.(
			{ text: "ordinary request", source: "interactive" },
			fixtureState.commandCtx,
		);
		expect(nextInput).toBeUndefined();
		expect(fixtureState.feature.getState()).toEqual({ mode: "inactive" });
	});

	test("preserves Goal runtime when tree transition fails", async () => {
		const fixtureState = fixture();
		await fixtureState.feature.start(fixtureState.runtime);
		await first(fixtureState.commands).handler("objective", fixtureState.commandCtx);
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

	test("aborts an owned run when the Goal runtime disposes", async () => {
		const fixtureState = fixture();
		await fixtureState.feature.start(fixtureState.runtime);
		await first(fixtureState.commands).handler("objective", fixtureState.commandCtx);
		await fixtureState.handlers.get("before_agent_start")?.(
			{ systemPrompt: "base" },
			fixtureState.commandCtx,
		);
		fixtureState.idle = false;
		await fixtureState.feature.dispose("goal-session");
		expect(fixtureState.aborted).toBe(1);
	});

	for (const eventName of ["session_before_switch", "session_before_fork"] as const) {
		test(`preserves Goal runtime when ${eventName} transition fails`, async () => {
			const fixtureState = fixture();
			await fixtureState.feature.start(fixtureState.runtime);
			await first(fixtureState.commands).handler("objective", fixtureState.commandCtx);
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
