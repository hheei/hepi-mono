import { setTimeout as sleep } from "node:timers/promises";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createToolTui } from "@hheei/pi-ext-core";
import { afterEach, expect, test } from "vitest";
import { registerBashTool } from "../src/bash.js";
import { BashJobRegistry, MAX_JOB_OUTPUT } from "../src/bash-jobs.js";
import { createFffRuntimeState, type FffRuntimeState } from "../src/fff/lifecycle.js";
import { DEFAULT_FFF_SETTINGS } from "../src/fff/settings.js";
import { registerTaskTools } from "../src/task-tools.js";
import {
	AsyncTaskRegistry,
	MAX_TASK_MESSAGE_CHARS,
	TASK_TERMINAL_CUSTOM_TYPE,
} from "../src/tasks/registry.js";

const registries: BashJobRegistry[] = [];
const taskRegistries: AsyncTaskRegistry[] = [];

afterEach((): void => {
	for (const registry of registries.splice(0)) registry.dispose();
	for (const registry of taskRegistries.splice(0)) registry.dispose();
});

async function eventually<T>(
	read: () => T | undefined,
	predicate: (value: T) => boolean,
): Promise<T> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const value = read();
		if (value !== undefined && predicate(value)) return value;
		await sleep(10);
	}
	throw new Error("expected state was not reached");
}

function tracked(registry: AsyncTaskRegistry): AsyncTaskRegistry {
	taskRegistries.push(registry);
	return registry;
}

function jobRegistry(): BashJobRegistry {
	const registry = new BashJobRegistry();
	registries.push(registry);
	return registry;
}

interface SentMessage {
	readonly customType: string;
	readonly content: string;
	readonly details: unknown;
}

function taskHost(): { readonly pi: ExtensionAPI; readonly sent: SentMessage[] } {
	const sent: SentMessage[] = [];
	const pi = {
		sendMessage(
			message: { customType: string; content: string; details: unknown },
			_options: unknown,
		): void {
			sent.push(message);
		},
	} as unknown as ExtensionAPI;
	return { pi, sent };
}

function toolHost(): {
	readonly pi: ExtensionAPI;
	readonly tools: ToolDefinition[];
} {
	const tools: ToolDefinition[] = [];
	const pi = {
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

function runtimeState(tasks: AsyncTaskRegistry | undefined): FffRuntimeState {
	const jobs = jobRegistry();
	return {
		getRuntime: () => undefined,
		getSettings: () => DEFAULT_FFF_SETTINGS,
		getTasks: () => tasks,
		getBashJobs: () => jobs,
		getTargetRuntime: () => undefined,
	};
}

test("retains bounded combined output and reports completion", async (): Promise<void> => {
	const registry = jobRegistry();
	const started = registry.start({ command: "yes x | head -c 1100000", cwd: process.cwd() });
	expect(() => structuredClone(started)).not.toThrow();
	const completed = await eventually(
		() => registry.get(started.id),
		(job) => job.status !== "running",
	);
	expect(completed.status).toBe("completed");
	expect(completed.truncated).toBe(true);
	expect(Buffer.byteLength(completed.output)).toBeLessThanOrEqual(MAX_JOB_OUTPUT);
});

test("stops an owned process group", async (): Promise<void> => {
	const registry = jobRegistry();
	const started = registry.start({ command: "sleep 10", cwd: process.cwd() });
	const stopped = registry.stop(started.id);
	expect(stopped?.status).toBe("stopped");
	await eventually(
		() => registry.get(started.id),
		(job) => job.status === "stopped",
	);
});

test("honors an async timeout", async (): Promise<void> => {
	const registry = jobRegistry();
	const started = registry.start({ command: "sleep 10", cwd: process.cwd(), timeoutMs: 25 });
	const stopped = await eventually(
		() => registry.get(started.id),
		(job) => job.status === "stopped",
	);
	expect(stopped.timedOut).toBe(true);
});

test("reports one terminal callback per finished job", async (): Promise<void> => {
	const registry = jobRegistry();
	const endings: string[] = [];
	registry.start({
		command: "printf task-output",
		cwd: process.cwd(),
		onTerminal: (job) => void endings.push(`${job.status}:${job.output}`),
	});
	const finished = await eventually(
		() => endings[0],
		(value) => value !== undefined,
	);
	expect(finished).toContain("completed");
	await sleep(20);
	expect(endings).toHaveLength(1);
});

test("assigns sequential per-family task ids", (): void => {
	const tasks = tracked(new AsyncTaskRegistry());
	const first = tasks.create({
		type: "bash",
		purpose: "printf one",
		begin: () => ({ stop: () => undefined, describe: () => ({ output: "", truncated: false }) }),
	});
	const second = tasks.create({
		type: "bash",
		purpose: "printf two",
		begin: () => ({ stop: () => undefined, describe: () => ({ output: "", truncated: false }) }),
	});
	expect([first.id, second.id]).toEqual(["bash-1", "bash-2"]);
	expect(tasks.list()).toHaveLength(2);
});

test("delivers one bounded terminal message per task", async (): Promise<void> => {
	const { pi, sent } = taskHost();
	const tasks = tracked(new AsyncTaskRegistry({ pi }));
	tasks.create({
		type: "bash",
		purpose: "printf done",
		begin: () => ({
			stop: () => undefined,
			describe: () => ({ output: "", truncated: false }),
		}),
	});
	tasks.settle("bash-1", {
		status: "completed",
		output: "x".repeat(MAX_TASK_MESSAGE_CHARS + 500),
		truncated: false,
	});
	tasks.settle("bash-1", { status: "failed", output: "late", truncated: false });
	await sleep(0);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.customType).toBe(TASK_TERMINAL_CUSTOM_TYPE);
	expect(sent[0]?.content).toContain("bash-1 finished: completed");
	expect(sent[0]?.content.length).toBeLessThan(MAX_TASK_MESSAGE_CHARS + 400);
	const waited = await tasks.wait(["bash-1"]);
	expect(waited[0]).toMatchObject({ id: "bash-1", status: "completed", delivered: true });
	expect(tasks.list()).toHaveLength(0);
	expect(tasks.list(true)).toHaveLength(1);
});

test("waits for every listed task and reports unknown ids", async (): Promise<void> => {
	const tasks = tracked(new AsyncTaskRegistry());
	tasks.create({
		type: "bash",
		purpose: "slow",
		begin: () => ({ stop: () => undefined, describe: () => ({ output: "", truncated: false }) }),
	});
	tasks.create({
		type: "bash",
		purpose: "fast",
		begin: () => ({ stop: () => undefined, describe: () => ({ output: "", truncated: false }) }),
	});
	tasks.settle("bash-2", { status: "completed", output: "fast done", truncated: false });
	const pending = tasks.wait(["bash-1", "bash-2", "bash-9"]);
	tasks.settle("bash-1", { status: "failed", output: "slow failed", truncated: false });
	const outcomes = await pending;
	expect(outcomes).toEqual([
		{
			id: "bash-1",
			status: "failed",
			waited: true,
			delivered: false,
			truncated: false,
			output: "slow failed",
		},
		{
			id: "bash-2",
			status: "completed",
			waited: true,
			delivered: false,
			truncated: false,
			output: "fast done",
		},
		{ id: "bash-9", status: "not_found" },
	]);
});

test("keeps waiting tasks alive when a wait is cancelled", async (): Promise<void> => {
	const tasks = tracked(new AsyncTaskRegistry());
	let stopped = 0;
	tasks.create({
		type: "bash",
		purpose: "long build",
		begin: () => ({
			stop: () => {
				stopped += 1;
			},
			describe: () => ({ output: "partial", truncated: false }),
		}),
	});
	const controller = new AbortController();
	const pending = tasks.wait(["bash-1"], controller.signal);
	controller.abort();
	const outcomes = await pending;
	expect(outcomes[0]).toMatchObject({ id: "bash-1", status: "running", waited: false });
	expect(stopped).toBe(0);
	expect(tasks.list()).toHaveLength(1);
});

test("stops a running task once and reports terminal ids", (): void => {
	const tasks = tracked(new AsyncTaskRegistry());
	let stopped = 0;
	tasks.create({
		type: "bash",
		purpose: "long build",
		begin: () => ({
			stop: () => {
				stopped += 1;
			},
			describe: () => ({ output: "", truncated: false }),
		}),
	});
	expect(tasks.stop(["bash-1", "bash-1", "missing"])).toEqual([
		{ id: "bash-1", status: "stop_requested" },
		{ id: "missing", status: "not_found" },
	]);
	expect(stopped).toBe(1);
	tasks.settle("bash-1", { status: "cancelled", output: "", truncated: false });
	expect(tasks.stop(["bash-1"])).toEqual([{ id: "bash-1", status: "already_terminal" }]);
});

test("settles a task that fails to start without delivering", (): void => {
	const { pi, sent } = taskHost();
	const tasks = tracked(new AsyncTaskRegistry({ pi }));
	expect(() =>
		tasks.create({
			type: "bash",
			purpose: "cannot start",
			begin: () => {
				throw new Error("spawn failed");
			},
		}),
	).toThrow("spawn failed");
	expect(sent).toHaveLength(0);
	expect(tasks.list(true)[0]).toMatchObject({ id: "bash-1", status: "failed" });
});

test("bash async returns a task id and one terminal delivery", async (): Promise<void> => {
	const { pi, sent } = taskHost();
	const tasks = tracked(new AsyncTaskRegistry({ pi }));
	const state = runtimeState(tasks);
	const host = toolHost();
	registerBashTool({ ...host.pi, sendMessage: pi.sendMessage.bind(pi) } as ExtensionAPI, state);
	const bash = host.tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("bash was not registered");
	const result = await bash.execute(
		"bash-async-task",
		{ command: "printf task-output", async: true },
		undefined,
		undefined,
		{ cwd: process.cwd() } as ExtensionContext,
	);
	expect(result.content).toEqual([
		{
			type: "text",
			text: "Started background task bash-1. Its result is added to the context when it finishes; use wait_tasks only if the next step needs it now.",
		},
	]);
	expect(result.details).toMatchObject({ taskId: "bash-1", type: "bash", status: "running" });
	const waited = await tasks.wait(["bash-1"]);
	expect(waited[0]).toMatchObject({ id: "bash-1", status: "completed", delivered: true });
	expect(sent).toHaveLength(1);
	expect(sent[0]?.content).toContain("task-output");
});

test("task tools report unavailable before session start", async (): Promise<void> => {
	const host = toolHost();
	registerTaskTools(host.pi, createFffRuntimeState());
	expect(host.tools.map((tool) => tool.name)).toEqual(["list_tasks", "wait_tasks", "stop_tasks"]);
	expect(host.tools[0]?.parameters).toMatchObject({
		additionalProperties: false,
		properties: { includeTerminal: { type: "boolean" } },
	});
	expect(host.tools[1]?.parameters).toMatchObject({
		additionalProperties: false,
		required: ["ids"],
	});
	for (const tool of host.tools) {
		const result = await tool.execute(
			"task-tool-1",
			tool.name === "list_tasks" ? {} : { ids: ["bash-1"] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(result).toMatchObject({
			content: [{ type: "text", text: "No active task session" }],
			details: { error: "session_unavailable" },
		});
	}
});

test("task tools list, wait for, and stop background tasks", async (): Promise<void> => {
	const tasks = tracked(new AsyncTaskRegistry());
	const host = toolHost();
	registerTaskTools(host.pi, runtimeState(tasks));
	const list = host.tools.find((tool) => tool.name === "list_tasks");
	const wait = host.tools.find((tool) => tool.name === "wait_tasks");
	const stop = host.tools.find((tool) => tool.name === "stop_tasks");
	if (list === undefined || wait === undefined || stop === undefined)
		throw new Error("task tools were not registered");
	tasks.create({
		type: "bash",
		purpose: "npm run build",
		begin: () => ({
			stop: () => tasks.settle("bash-1", { status: "cancelled", output: "", truncated: false }),
			describe: () => ({ output: "", truncated: false }),
		}),
	});
	const listed = await list.execute("list", {}, undefined, undefined, {} as ExtensionContext);
	expect(listed.content).toEqual([
		{ type: "text", text: expect.stringContaining("bash-1 running · npm run build") },
	]);
	const stopping = await stop.execute(
		"stop",
		{ ids: ["bash-1"] },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	expect(stopping.content).toEqual([{ type: "text", text: "bash-1 stop requested" }]);
	const waited = await wait.execute(
		"wait",
		{ ids: ["bash-1"] },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	expect(waited.content[0]).toMatchObject({ type: "text" });
	expect((waited.content[0] as { text: string }).text).toContain("bash-1 cancelled");
	expect(waited.details).toMatchObject({ tasks: [{ id: "bash-1", status: "cancelled" }] });
	const empty = await list.execute("list", {}, undefined, undefined, {} as ExtensionContext);
	expect(empty.content).toEqual([{ type: "text", text: "No running background tasks." }]);
	for (const tool of [wait, stop]) {
		const rejected = await tool.execute(
			"invalid",
			{ ids: [] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(rejected.details).toMatchObject({ error: "invalid_ids" });
	}
});

const plainTheme = {
	bg: (_role: string, text: string): string => text,
	fg: (_role: string, text: string): string => text,
	bold: (text: string): string => text,
} as unknown as Theme;

test("renders task tool headers inside narrow terminal widths", async (): Promise<void> => {
	const tasks = tracked(new AsyncTaskRegistry());
	const host = toolHost();
	const tui = createToolTui();
	registerTaskTools(host.pi, runtimeState(tasks), tui);
	const wait = host.tools.find((tool) => tool.name === "wait_tasks");
	if (wait === undefined) throw new Error("wait_tasks was not registered");
	for (const context of [
		{ isPartial: true, executionStarted: false, expanded: false },
		{ isPartial: false, executionStarted: true, expanded: false },
		{ isPartial: false, executionStarted: true, expanded: true },
	]) {
		const lines =
			wait
				.renderCall?.({ ids: ["bash-1", "bash-2", "bash-3"] }, plainTheme, {
					...context,
					isError: false,
					lastComponent: undefined,
					state: {},
					toolCallId: "narrow-wait",
					invalidate: (): void => undefined,
				} as never)
				?.render(30) ?? [];
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	}

	tui.beginTrace();
	const collapsed =
		wait
			.renderCall?.({ ids: ["bash-1", "bash-2", "bash-3"] }, plainTheme, {
				isPartial: false,
				isError: false,
				executionStarted: true,
				expanded: false,
				lastComponent: undefined,
				state: {},
				toolCallId: "narrow-wait",
				invalidate: (): void => undefined,
			} as never)
			?.render(30) ?? [];
	expect(collapsed).toHaveLength(1);
	for (const line of collapsed) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
});
