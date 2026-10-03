import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createToolTui,
	type ExtensionLifecycleContext,
	isTerminalTaskStatus,
	TaskRegistry,
} from "@hheei/pi-ext-core";
import { afterEach, expect, test } from "vitest";
import { registerBashTool } from "../src/bash.js";
import { BashJobRegistry, MAX_JOB_OUTPUT } from "../src/bash-jobs.js";
import { createFffRuntimeState, type FffRuntimeState } from "../src/fff/lifecycle.js";
import { DEFAULT_FFF_SETTINGS, type FffSettings } from "../src/fff/settings.js";
import { registerTaskTools, startTaskControl, TASK_TOOL_IDS } from "../src/task-tools.js";
import { framedHost, toolFor, toolHost } from "./fixtures/harness.js";
import { plainTheme } from "./fixtures/theme.js";

const registries: BashJobRegistry[] = [];
const taskRegistries: TaskRegistry[] = [];

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

function tracked(registry: TaskRegistry): TaskRegistry {
	taskRegistries.push(registry);
	return registry;
}

function jobRegistry(): BashJobRegistry {
	const registry = new BashJobRegistry();
	registries.push(registry);
	return registry;
}

function runtimeState(
	tasks: TaskRegistry | undefined,
	settingsOverrides?: Partial<typeof DEFAULT_FFF_SETTINGS>,
): FffRuntimeState {
	const jobs = jobRegistry();
	return {
		getRuntime: () => undefined,
		getSettings: () => ({ ...DEFAULT_FFF_SETTINGS, ...(settingsOverrides ?? {}) }),
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

test("stops an owned process group, not just the job shell", async (): Promise<void> => {
	const dir = await mkdtemp(join(tmpdir(), "hepi-bash-jobs-"));
	const pidFile = join(dir, "descendant.pid");
	const readDescendant = (): number => {
		try {
			return Number(readFileSync(pidFile, "utf8"));
		} catch {
			return Number.NaN;
		}
	};
	const isAlive = (pid: number): boolean => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	try {
		const registry = jobRegistry();
		const started = registry.start({
			command: `sleep 30 & echo $! > ${pidFile}; sleep 30`,
			cwd: process.cwd(),
		});
		const descendant = await eventually(readDescendant, (pid) => Number.isInteger(pid) && pid > 0);
		expect(isAlive(descendant)).toBe(true);
		const stopped = registry.stop(started.id);
		expect(stopped?.status).toBe("stopped");
		await eventually(
			() => registry.get(started.id),
			(job) => job.status === "stopped",
		);
		await eventually(
			() => isAlive(descendant),
			(alive) => !alive,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
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
	const tasks = tracked(new TaskRegistry());
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

test("keeps one terminal result when a second settle arrives late", (): void => {
	const tasks = tracked(new TaskRegistry());
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
		output: "kept",
		truncated: false,
		detail: { jobId: "job" },
	});
	tasks.settle("bash-1", { status: "failed", output: "late", truncated: false });
	expect(tasks.list()).toHaveLength(0);
	expect(tasks.list(true)).toHaveLength(1);
	expect(tasks.get("bash-1")).toMatchObject({
		status: "completed",
		delivery: "pending",
	});
});

test("waits for every listed task and reports unknown ids", async (): Promise<void> => {
	const tasks = tracked(new TaskRegistry());
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
			delivery: "pending",
			truncated: false,
			output: "slow failed",
		},
		{
			id: "bash-2",
			status: "completed",
			waited: true,
			delivery: "pending",
			truncated: false,
			output: "fast done",
		},
		{ id: "bash-9", status: "not_found" },
	]);
});

test("keeps waiting tasks alive when a wait is cancelled", async (): Promise<void> => {
	const tasks = tracked(new TaskRegistry());
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
	const tasks = tracked(new TaskRegistry());
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

test("settles a task that fails to start without claiming it started", (): void => {
	const tasks = tracked(new TaskRegistry());
	expect(() =>
		tasks.create({
			type: "bash",
			purpose: "cannot start",
			begin: () => {
				throw new Error("spawn failed");
			},
		}),
	).toThrow("spawn failed");
	expect(tasks.list(true)[0]).toMatchObject({ id: "bash-1", status: "failed" });
});

test("background bash returns a job id whose result arrives through wait_jobs", async (): Promise<void> => {
	const tasks = tracked(new TaskRegistry());
	const state = runtimeState(tasks);
	const host = toolHost();
	registerBashTool(host.pi, state);
	const bash = toolFor(host.tools, "bash");
	const result = await runTool(bash, "bash-async-task", {
		command: "printf task-output",
		blocking: false,
	});
	expect(result.content).toEqual([
		{
			type: "text",
			text: "Started background job bash-1. Its result is added to the context when it finishes; use wait_jobs only if the next step needs it now.",
		},
	]);
	expect(result.details).toMatchObject({ taskId: "bash-1", type: "bash", status: "running" });
	const waited = await tasks.wait(["bash-1"]);
	expect(waited[0]).toMatchObject({ id: "bash-1", status: "completed", delivery: "pending" });
	if (waited[0] === undefined || waited[0].status === "not_found")
		throw new Error("expected a result");
	expect(waited[0].output).toContain("task-output");
});

test("reports a background task that cannot start", async (): Promise<void> => {
	const tasks = tracked(new TaskRegistry());
	const state: FffRuntimeState = {
		...runtimeState(tasks),
		getBashJobs: () =>
			({
				start: () => {
					throw new Error("registry is disposed");
				},
			}) as never,
	};
	const host = toolHost();
	registerBashTool(host.pi, state);
	const bash = toolFor(host.tools, "bash");
	const result = await runTool(bash, "bash-start-failure", {
		command: "printf never",
		blocking: false,
	});
	expect(result.content).toEqual([
		{ type: "text", text: "Unable to start background job: registry is disposed" },
	]);
	expect(result.details).toMatchObject({ error: "start_failed" });
	expect(tasks.list(true)[0]).toMatchObject({ id: "bash-1", status: "failed" });
});

test("task tools report unavailable before session start", async (): Promise<void> => {
	const host = toolHost();
	registerTaskTools(host.pi, createFffRuntimeState());
	expect(host.tools.map((tool) => tool.name)).toEqual(["list_jobs", "wait_jobs", "stop_jobs"]);
	expect(host.tools[0]?.parameters).toMatchObject({
		additionalProperties: false,
		properties: { includeTerminal: { type: "boolean" } },
	});
	expect(host.tools[1]?.parameters).toMatchObject({
		additionalProperties: false,
		required: ["ids"],
	});
	for (const tool of host.tools) {
		const result = await runTool(
			tool,
			"task-tool-1",
			tool.name === "list_jobs" ? {} : { ids: ["bash-1"] },
		);
		expect(result).toMatchObject({
			content: [{ type: "text", text: "No active task session" }],
			details: { error: "session_unavailable" },
		});
	}
});

test("task tools list, wait for, and stop background tasks", async (): Promise<void> => {
	const tasks = tracked(new TaskRegistry());
	const host = toolHost();
	registerTaskTools(host.pi, runtimeState(tasks));
	const list = toolFor(host.tools, "list_jobs");
	const wait = toolFor(host.tools, "wait_jobs");
	const stop = toolFor(host.tools, "stop_jobs");
	tasks.create({
		type: "bash",
		purpose: "npm run build",
		begin: () => ({
			stop: () => tasks.settle("bash-1", { status: "cancelled", output: "", truncated: false }),
			describe: () => ({ output: "", truncated: false }),
		}),
	});
	const listed = await runTool(list, "list", {});
	expect(listed.content).toEqual([
		{ type: "text", text: expect.stringContaining("bash-1 running · npm run build") },
	]);
	const stopping = await runTool(stop, "stop", { ids: ["bash-1"] });
	expect(stopping.content).toEqual([{ type: "text", text: "bash-1 stop requested" }]);
	const waited = await runTool(wait, "wait", { ids: ["bash-1"] });
	expect(waited.content[0]).toMatchObject({ type: "text" });
	expect((waited.content[0] as { text: string }).text).toContain("bash-1 cancelled");
	expect(waited.details).toMatchObject({
		tasks: [{ id: "bash-1", status: "cancelled", delivery: "pending" }],
	});
	const empty = await runTool(list, "list", {});
	expect(empty.content).toEqual([{ type: "text", text: "No active background jobs." }]);
	const finished = await runTool(list, "list-finished", { includeTerminal: true });
	expect(finished.content).toEqual([
		{ type: "text", text: expect.stringContaining("bash-1 cancelled · npm run build") },
	]);
	expect(finished.content).toEqual([
		{ type: "text", text: expect.stringContaining("result not sent") },
	]);
	for (const tool of [wait, stop]) {
		const rejected = await runTool(tool, "invalid", { ids: [] });
		expect(rejected.details).toMatchObject({ error: "invalid_ids" });
	}
});

test("renders task tool headers inside narrow terminal widths", async (): Promise<void> => {
	const tasks = tracked(new TaskRegistry());
	const { pi, tools, tui } = framedHost();
	registerTaskTools(pi, runtimeState(tasks), tui);
	const wait = toolFor(tools, "wait_jobs");
	for (const context of [
		{ isPartial: true, executionStarted: false, expanded: false },
		{ isPartial: false, executionStarted: true, expanded: false },
		{ isPartial: false, executionStarted: true, expanded: true },
	]) {
		const lines =
			wait
				.renderCall?.({ ids: ["bash-test-1", "bash-test-2", "bash-test-3"] }, plainTheme, {
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
			.renderCall?.({ ids: ["bash-test-1", "bash-test-2", "bash-test-3"] }, plainTheme, {
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

test("terminalizes a job whose shell cannot be spawned", async (): Promise<void> => {
	const registry = jobRegistry();
	const endings: string[] = [];
	const started = registry.start({
		command: "printf never",
		cwd: process.cwd(),
		shellPath: "/nonexistent/pi-ext-tools-shell",
		onTerminal: (job) => void endings.push(`${job.status}:${job.output}`),
	});
	const finished = await eventually(
		() => endings[0],
		(value) => value !== undefined,
	);
	expect(finished).toContain("failed");
	expect(finished).toContain("ENOENT");
	expect(registry.get(started.id)?.status).toBe("failed");
	await sleep(20);
	expect(endings).toHaveLength(1);
});

test("bounds the records left by repeated start failures", (): void => {
	// A synchronous startup failure is reported to the caller, so it reserves no capacity.
	const tasks = tracked(new TaskRegistry());
	for (let attempt = 0; attempt < 80; attempt += 1)
		expect(() =>
			tasks.create({
				type: "bash",
				purpose: "cannot start",
				begin: () => {
					throw new Error("spawn failed");
				},
			}),
		).toThrow("spawn failed");
	// Failed startups are terminal records, so they obey the same 64-record retention cap.
	expect(tasks.list(true).length).toBeLessThanOrEqual(64);
});

function taskFrame(tool: ToolDefinition, args: unknown, toolCallId: string): string {
	return (
		tool
			.renderCall?.(args, plainTheme, {
				isPartial: false,
				isError: false,
				executionStarted: true,
				expanded: false,
				lastComponent: undefined,
				state: {},
				toolCallId,
				invalidate: (): void => undefined,
			} as never)
			?.render(80)
			.join("\n") ?? ""
	);
}

test("warns on stop_jobs only when an id did not stop", async (): Promise<void> => {
	const tasks = tracked(new TaskRegistry());
	const host = toolHost();
	registerTaskTools(host.pi, runtimeState(tasks), createToolTui());
	const stop = toolFor(host.tools, "stop_jobs");
	tasks.create({
		type: "bash",
		purpose: "npm run build",
		begin: () => ({ stop: () => undefined, describe: () => ({ output: "", truncated: false }) }),
	});
	await runTool(stop, "stop-live", { ids: ["bash-1"] });
	expect(taskFrame(stop, { ids: ["bash-1"] }, "stop-live")).toContain("󰄴 stop_jobs bash-1");
	tasks.settle("bash-1", { status: "cancelled", output: "", truncated: false });
	await runTool(stop, "stop-done", { ids: ["bash-1"] });
	expect(taskFrame(stop, { ids: ["bash-1"] }, "stop-done")).toContain("󰄴 stop_jobs bash-1");
	await runTool(stop, "stop-missing", { ids: ["bash-9"] });
	expect(taskFrame(stop, { ids: ["bash-9"] }, "stop-missing")).toContain("󰀪 stop_jobs bash-9");
});

test("a command stays in foreground and runs to completion", async (): Promise<void> => {
	const short = bashHarness();
	const res = await short.bash.execute(
		"bash-foreground-short",
		{ command: "node -e \"console.log('short-output')\"" },
		undefined,
		undefined,
		toolContext(),
	);
	expect(res.content).toEqual([{ type: "text", text: "short-output\n" }]);
	expect(res.details).toMatchObject({ exitCode: 0 });
	expect(short.tasks.list(true)).toEqual([]);
});

test("command without explicit timeout stays in foreground and does not auto-transition to background", async (): Promise<void> => {
	const tasks = tracked(new TaskRegistry());
	const state = runtimeState(tasks);
	const host = toolHost();
	registerBashTool(host.pi, state);
	const bash = toolFor(host.tools, "bash");

	const res = await runTool(bash, "bash-foreground-stay", {
		command: "printf 'hello foreground'",
	});

	expect(res.details).not.toHaveProperty("taskId");
	expect(res.content[0]?.type === "text" ? res.content[0].text : "").toContain("hello foreground");
	expect(tasks.activeCount).toBe(0);
});

test("explicit timeout does not transition to async task", async (): Promise<void> => {
	const { bash, tasks } = bashHarness();

	const res = await runTool(bash, "bash-explicit-timeout", {
		command: 'node -e "setTimeout(() => {}, 500)"',
		timeout: 0.1,
	});

	expect(res.details).toMatchObject({ timedOut: true });
	expect((res.details as Record<string, unknown>).taskId).toBeUndefined();
	expect(tasks.list(true)).toEqual([]);
});

test("aborting foreground command kills the process", async (): Promise<void> => {
	const { bash, tasks } = bashHarness();

	const controller = new AbortController();
	setTimeout(() => controller.abort(), 40);

	const res = await runTool(
		bash,
		"bash-abort",
		{ command: 'node -e "setTimeout(() => {}, 2000)"' },
		{ signal: controller.signal },
	);

	expect(res.content).toEqual([{ type: "text", text: "Bash aborted" }]);
	expect(res.details).toMatchObject({ error: "aborted" });
	expect(tasks.list(true)).toEqual([]);
});
test("waitFor and bindTerminal on BashJobRegistry", async (): Promise<void> => {
	const registry = jobRegistry();
	const job = registry.start({
		command: 'node -e "setTimeout(() => {}, 50)"',
		cwd: process.cwd(),
	});
	const waited = await registry.waitFor(job.id);
	expect(waited?.status).toBe("completed");

	// bindTerminal after already terminalized invokes callback immediately
	let terminalReported: string | undefined;
	registry.bindTerminal(job.id, (snapshot) => {
		terminalReported = snapshot.status;
	});
	expect(terminalReported).toBe("completed");
});

test("dispose stops running jobs with stopped status and releases waiters", async (): Promise<void> => {
	const registry = jobRegistry();
	const job = registry.start({
		command: 'node -e "setTimeout(() => {}, 2000)"',
		cwd: process.cwd(),
	});
	const waitPromise = registry.waitFor(job.id);
	registry.dispose();
	const snapshot = await waitPromise;
	expect(snapshot?.status).toBe("stopped");
	expect(typeof snapshot?.endedAt).toBe("number");
});

test("keeps the command in the foreground when background tasks are not requested", async (): Promise<void> => {
	const { bash } = bashHarness();

	const res = await runTool(bash, "bash-no-bg", {
		command: 'printf "completed-in-foreground"',
	});

	expect(res.details).toMatchObject({ exitCode: 0 });
	expect(res.details).not.toHaveProperty("taskId");
	expect(res.content).toEqual([
		{ type: "text", text: expect.stringContaining("completed-in-foreground") },
	]);
});

interface TaskControlHost {
	readonly pi: ExtensionAPI;
	readonly tools: ToolDefinition[];
	readonly context: ExtensionLifecycleContext;
	readonly activeTools: () => readonly string[];
	emit(event: "session_compact" | "session_tree"): void;
	cleanup(): Promise<void>;
}

/** Every tool of the static catalog, as the Host activates them at session start. */
const HOST_ACTIVE_TOOLS: readonly string[] = [
	"read",
	"grep",
	"find",
	"edit",
	"write",
	"bash",
	"ls",
	"list_jobs",
	"wait_jobs",
	"stop_jobs",
	"apply_patch",
	"eval",
];

function taskControlHost(): TaskControlHost {
	const tools: ToolDefinition[] = [];
	const listeners = new Map<string, Set<() => void>>();
	const cleanups: Array<() => void> = [];
	let activeTools: string[] = [...HOST_ACTIVE_TOOLS];
	const pi = {
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
		getActiveTools: (): readonly string[] => activeTools,
		setActiveTools(names: string[]): void {
			activeTools = names;
		},
		on(event: string, handler: () => void): () => void {
			const group = listeners.get(event) ?? new Set<() => void>();
			group.add(handler);
			listeners.set(event, group);
			return (): void => {
				group.delete(handler);
			};
		},
		sendMessage: (): void => {},
	} as unknown as ExtensionAPI;
	return {
		pi,
		tools,
		context: {
			pi,
			resources: {
				add: (_id: string, cleanup: () => void): void => {
					cleanups.push(cleanup);
				},
			},
			signal: new AbortController().signal,
			// Task delivery reads only the current branch and the session ui.
			extension: {
				sessionManager: { getBranch: () => [] },
				ui: { notify: (): void => undefined },
			},
		} as unknown as ExtensionLifecycleContext,
		activeTools: () => activeTools,
		emit: (event) => {
			for (const handler of [...(listeners.get(event) ?? [])]) handler();
		},
		cleanup: async (): Promise<void> => {
			for (const cleanup of [...cleanups].reverse()) cleanup();
		},
	};
}

function withoutTaskTools(active: readonly string[]): readonly string[] {
	return active.filter((id) => !TASK_TOOL_IDS.includes(id));
}

/** Registers the task catalog as extension construction does, then starts one session. */
function taskControlSession(overrides?: Partial<FffSettings>): {
	readonly host: TaskControlHost;
	readonly tasks: TaskRegistry;
} {
	const host = taskControlHost();
	// The session registry is attached only once `startTaskControl` has created it.
	let current: TaskRegistry | undefined;
	const state: FffRuntimeState = {
		...runtimeState(undefined, overrides),
		getTasks: () => current,
	};
	registerTaskTools(host.pi, state);
	registerBashTool(host.pi, state);
	const tasks = tracked(startTaskControl(host.context));
	current = tasks;
	return { host, tasks };
}

/** Reads the task id a bash result reports, so a session-minted id is never hard-coded. */
function taskIdOf(result: { readonly details?: unknown }): string {
	const details = result.details;
	if (typeof details !== "object" || details === null) throw new Error("expected tool details");
	const taskId = (details as { readonly taskId?: unknown }).taskId;
	if (typeof taskId !== "string") throw new Error("expected a background task id");
	return taskId;
}

/** Executes a registered tool the way Pi does, at the session cwd. */
function runTool(
	bash: ToolDefinition,
	toolCallId: string,
	args: Record<string, unknown>,
	options: {
		readonly signal?: AbortSignal;
		readonly onUpdate?: (update: unknown) => void;
	} = {},
) {
	return bash.execute(toolCallId, args, options.signal, options.onUpdate, toolContext());
}

/** Minimal Pi tool context: a cwd plus the session methods the bash tool reads. */
function toolContext(leafId: string | null = "entry-1"): ExtensionToolContext {
	return {
		cwd: process.cwd(),
		sessionManager: { getLeafId: () => leafId },
		ui: { notify: (): void => undefined },
	} as unknown as ExtensionToolContext;
}

/** Registers the bash tool over a fresh task registry, the way one session does. */
function bashHarness(settings?: Partial<FffSettings>): {
	readonly bash: ToolDefinition;
	readonly tasks: TaskRegistry;
} {
	const tasks = tracked(new TaskRegistry());
	const host = toolHost();
	registerBashTool(host.pi, runtimeState(tasks, settings));
	return { bash: toolFor(host.tools, "bash"), tasks };
}

test("host-activated task tools are removed at session start", (): void => {
	const host = taskControlHost();
	// Precondition: Pi activates every registered extension tool before session_start runs.
	expect(host.activeTools()).toContain("list_jobs");
	registerTaskTools(host.pi, runtimeState(undefined));

	tracked(startTaskControl(host.context));

	expect(host.activeTools()).toEqual(withoutTaskTools(HOST_ACTIVE_TOOLS));
});

test("task tools activate on the first background task, survive turns, and unload at a boundary", async (): Promise<void> => {
	const { host, tasks } = taskControlSession();
	expect(host.activeTools()).toEqual(withoutTaskTools(HOST_ACTIVE_TOOLS));

	const started = await toolFor(host.tools, "bash").execute(
		"bash-on-demand",
		{ command: "printf task-output", blocking: false },
		undefined,
		undefined,
		toolContext(),
	);
	// The session registry mints its own runtime discriminator, so read the id back.
	const firstId = taskIdOf(started);
	expect(firstId).toBe("bash-1");
	expect(tasks.activeCount).toBe(1);
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));

	await tasks.wait([firstId]);
	expect(tasks.activeCount).toBe(0);
	// Ordinary turns keep the tools: a finished task must stay inspectable and activation must not churn.
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));

	// The result still needs notification, so a boundary cannot unload the tools yet.
	host.emit("session_compact");
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));
	// Handing the result to the host is not proof that the model read it, so the tools stay until
	// the message lifecycle confirms it.
	tasks.markSubmitted([firstId], "first-delivery");
	host.emit("session_compact");
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));
	tasks.markObserved("first-delivery");
	host.emit("session_compact");
	expect(host.activeTools()).toEqual(withoutTaskTools(HOST_ACTIVE_TOOLS));

	// The next task brings them back.
	const second = await toolFor(host.tools, "bash").execute(
		"bash-reactivate",
		{ command: "printf second", blocking: false },
		undefined,
		undefined,
		toolContext(),
	);
	const secondId = taskIdOf(second);
	expect(secondId).toBe("bash-2");
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));
	await tasks.wait([secondId]);
});

test("activation follows running tasks across boundaries and auto-async transitions", async (): Promise<void> => {
	const { host, tasks } = taskControlSession({ autoAsyncSeconds: 0.05 });
	const runningId = taskIdOf(
		await toolFor(host.tools, "bash").execute(
			"bash-boundary-running",
			{ command: 'node -e "setTimeout(() => {}, 3000)"', blocking: false },
			undefined,
			undefined,
			toolContext(),
		),
	);
	expect(tasks.activeCount).toBe(1);

	host.emit("session_compact");
	host.emit("session_tree");
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));

	tasks.stop([runningId]);
	await eventually(
		() => tasks.get(runningId),
		(task) => isTerminalTaskStatus(task.status),
	);
	// This producer confirms the stop synchronously, so the request was visible as `stopping` only
	// while it was in flight.
	expect(tasks.activeCount).toBe(0);
	// A cancelled task still needs its control tools until the result is handed to the parent.
	expect(tasks.requiresControl).toBe(true);
	host.emit("session_compact");
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));
	tasks.markSubmitted([runningId], "session-boundary");
	host.emit("session_compact");
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));
	tasks.markObserved("session-boundary");
	host.emit("session_compact");
	expect(host.activeTools()).toEqual(withoutTaskTools(HOST_ACTIVE_TOOLS));

	// Another background job brings them back.
	const res = await toolFor(host.tools, "bash").execute(
		"bash-another-job",
		{ command: "printf third", blocking: false },
		undefined,
		undefined,
		toolContext(),
	);
	const newId = taskIdOf(res);
	expect(tasks.activeCount).toBe(1);
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));
	await tasks.wait([newId]);
});

test("a boundary restores control tools the host re-activated behind a waiting result", async (): Promise<void> => {
	const { host, tasks } = taskControlSession({ autoAsyncSeconds: 0.05 });
	const running = taskIdOf(
		await toolFor(host.tools, "bash").execute(
			"bash-tree-restore",
			{ command: 'node -e "setTimeout(() => {}, 120)"', blocking: false },
			undefined,
			undefined,
			toolContext(),
		),
	);
	await eventually(
		() => tasks.get(running),
		(task) => task.status !== "running",
	);

	// `/tree` republishes the transcript tool set, so control can come back even though nothing
	// asked for it: a result still waiting for the parent must keep its readers available.
	host.pi.setActiveTools([...HOST_ACTIVE_TOOLS].filter((id) => !TASK_TOOL_IDS.includes(id)));
	host.emit("session_tree");
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));

	tasks.markSubmitted([running], "tree-restore");
	host.emit("session_tree");
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));
	tasks.markObserved("tree-restore");
	host.emit("session_tree");
	expect(host.activeTools()).toEqual(withoutTaskTools(HOST_ACTIVE_TOOLS));
});

test("a task that cannot start leaves the tools off, and teardown clears the next session", (): void => {
	const host = taskControlHost();
	registerTaskTools(host.pi, runtimeState(undefined));
	const tasks = tracked(startTaskControl(host.context));

	expect(() =>
		tasks.create({
			type: "bash",
			purpose: "cannot start",
			begin: () => {
				throw new Error("spawn failed");
			},
		}),
	).toThrow("spawn failed");
	expect(tasks.activeCount).toBe(0);
	expect(host.activeTools()).toEqual(withoutTaskTools(HOST_ACTIVE_TOOLS));

	// Session teardown disposes the registry, so the next session starts clean.
	tasks.create({
		type: "bash",
		purpose: "still running",
		begin: () => ({
			stop: (): void => undefined,
			describe: () => ({ output: "", truncated: false }),
		}),
	});
	expect(tasks.activeCount).toBe(1);
	tasks.dispose();
	expect(tasks.activeCount).toBe(0);

	const second = taskControlSession();
	expect(second.tasks.activeCount).toBe(0);
	expect(second.host.activeTools()).toEqual(withoutTaskTools(HOST_ACTIVE_TOOLS));
});

test("session teardown releases the boundary listeners", async (): Promise<void> => {
	const { host } = taskControlSession();
	await host.cleanup();

	host.pi.setActiveTools(["read", ...TASK_TOOL_IDS]);
	host.emit("session_compact");
	expect(host.pi.getActiveTools()).toEqual(["read", ...TASK_TOOL_IDS]);
});

test("cleanly terminalizes when command exits but descendant holds stdio open", async (): Promise<void> => {
	const registry = jobRegistry();
	const started = registry.start({
		command: "python3 -c 'import time; time.sleep(10)' 1>&2 & exit 0",
		cwd: process.cwd(),
	});
	const completed = await eventually(
		() => registry.get(started.id),
		(job) => job.status !== "running",
	);
	expect(completed.status).toBe("completed");
});

test("cleanly terminalizes when stopped even if descendant holds stdio open", async (): Promise<void> => {
	const registry = jobRegistry();
	const started = registry.start({
		command: "python3 -c 'import time; time.sleep(30)' 1>&2 & sleep 30",
		cwd: process.cwd(),
	});
	await sleep(50);
	registry.stop(started.id);
	const stopped = await eventually(
		() => registry.get(started.id),
		(job) => job.status === "stopped",
	);
	expect(stopped.status).toBe("stopped");
});
