import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type ExtensionLifecycleContext, TaskRegistry } from "@hheei/pi-ext-core";
import { afterEach, expect, test } from "vitest";
import { registerBashTool } from "../src/bash.js";
import { BashJobRegistry, MAX_JOB_OUTPUT } from "../src/bash-jobs.js";
import piExtToolsExtension from "../src/extension.js";
import { createFffRuntimeState, type FffRuntimeState } from "../src/fff/lifecycle.js";
import { DEFAULT_FFF_SETTINGS, type FffSettings } from "../src/fff/settings.js";
import { registerTaskTools, startTaskControl, TASK_TOOL_IDS } from "../src/task-tools.js";
import { toolFor, toolHost } from "./fixtures/harness.js";

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

test("bg_bash_spawn returns id and log path; get uses the same path key", async (): Promise<void> => {
	const tasks = tracked(new TaskRegistry());
	const state = runtimeState(tasks);
	const host = toolHost();
	registerBashTool(host.pi, state);
	const spawnBash = toolFor(host.tools, "bg_bash_spawn");
	await expect(
		runTool(spawnBash, "caller-id", { command: "printf never", id: "bash-1" }),
	).rejects.toThrow("Invalid bg_bash_spawn parameters");
	const started = await runTool(spawnBash, "bash-async-task", {
		command: "printf task-output",
	});
	const content = started.content[0];
	if (content?.type !== "text") throw new Error("expected spawn result text");
	const spawned = JSON.parse(content.text);
	expect(spawned).toEqual({ id: "bash-1", path: expect.stringMatching(/bash-1\.log$/) });
	expect(isAbsolute(spawned.path)).toBe(true);
	expect(started.details).toEqual(spawned);
	expect(started).not.toHaveProperty("structuredContent");
	registerTaskTools(host.pi, state);
	const progress = await runTool(toolFor(host.tools, "bg_bash_get"), "inspect", {
		id: "bash-1",
		keys: "progress",
	});
	expect(progress.details).toMatchObject({
		progress: { path: spawned.path },
	});
	const waited = await tasks.wait(["bash-1"]);
	expect(waited[0]).toMatchObject({ id: "bash-1", status: "completed", delivery: "pending" });
	if (waited[0] === undefined || waited[0].status === "not_found")
		throw new Error("expected a result");
	expect(waited[0].output).toContain("task-output");
	expect(readFileSync(spawned.path, "utf8")).toContain("task-output");
});

test("reports a background task that cannot start", async (): Promise<void> => {
	const tasks = tracked(new TaskRegistry());
	const jobs = jobRegistry();
	jobs.dispose();
	const state: FffRuntimeState = {
		...runtimeState(tasks),
		getBashJobs: () => jobs,
	};
	const host = toolHost();
	registerBashTool(host.pi, state);
	const spawnBash = toolFor(host.tools, "bg_bash_spawn");
	const result = await runTool(spawnBash, "bash-start-failure", {
		command: "printf never",
	});
	expect(result.content).toEqual([
		{ type: "text", text: "Unable to start background job: Bash job registry is disposed" },
	]);
	expect(result.details).toBeUndefined();
	expect(result).toMatchObject({ isError: true });
	expect(result).not.toHaveProperty("structuredContent");
	expect(tasks.list(true)[0]).toMatchObject({ id: "bash-1", status: "failed" });
});

test("background Bash controls reject missing sessions", async () => {
	const host = toolHost();
	registerTaskTools(host.pi, createFffRuntimeState());
	expect(host.tools.map((tool) => tool.name)).toEqual(["bg_bash_get", "bg_bash_stop"]);
	for (const tool of host.tools) {
		expect(tool.exposure).toBe("deferred");
		expect(tool.defaultActive).toBe(false);
		await expect(runTool(tool, "unavailable", { id: "bash-1" })).rejects.toThrow(
			"No active background Bash session",
		);
	}
});

test("background Bash controls project runtime fields without consuming terminal delivery", async () => {
	const tasks = tracked(new TaskRegistry());
	const state = runtimeState(tasks);
	const host = toolHost();
	registerTaskTools(host.pi, state);
	const get = toolFor(host.tools, "bg_bash_get");
	const stop = toolFor(host.tools, "bg_bash_stop");
	let stopped = 0;
	tasks.create({
		type: "bash",
		purpose: "npm run build",
		begin: () => ({
			stop: () => {
				stopped += 1;
				tasks.settle("bash-1", {
					status: "cancelled",
					output: "terminal output",
					truncated: false,
				});
			},
			describe: () => ({ output: "partial", truncated: false }),
		}),
	});
	const running = await runTool(get, "get", { id: "bash-1" });
	expect(running.details).toEqual({ status: "running", progress: { command: "npm run build" } });
	expect((await runTool(get, "project", { id: "bash-1", keys: "status" })).details).toEqual({
		status: "running",
	});
	await expect(runTool(get, "unknown", { id: "bash-1", keys: "output" })).rejects.toThrow(
		"Unknown bg_bash_get key",
	);
	const stoppedResult = await runTool(stop, "stop", { id: "bash-1" });
	expect(stoppedResult.content).toEqual([{ type: "text", text: "Stop requested." }]);
	expect(stoppedResult.details).toBeUndefined();
	expect(stopped).toBe(1);
	expect((await runTool(stop, "stop-again", { id: "bash-1" })).content).toEqual([
		{ type: "text", text: "Task already finished." },
	]);
	const finished = await runTool(get, "finished", { id: "bash-1" });
	expect(finished.details).toEqual({ status: "cancelled", progress: { command: "npm run build" } });
	expect(JSON.stringify(finished)).not.toContain("terminal output");
	expect(tasks.pendingDeliveries()).toHaveLength(1);
	tasks.create({
		type: "agent",
		purpose: "agent task",
		begin: () => ({ stop: () => undefined, describe: () => ({ output: "", truncated: false }) }),
	});
	for (const tool of [get, stop]) {
		await expect(runTool(tool, "wrong-type", { id: "agent-1" })).rejects.toThrow(
			"Background Bash task agent-1 not found",
		);
	}
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
	"bg_bash_spawn",
	"ls",
	"bg_bash_get",
	"bg_bash_stop",
	"apply_patch",
	"python_eval",
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
function taskIdOf(result: {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
	const first = result.content[0];
	if (first?.type !== "text" || first.text === undefined)
		throw new Error("expected a background task id");
	return JSON.parse(first.text).id;
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

test("task tools remain permanently active without dynamic flapping", (): void => {
	const host = taskControlHost();
	expect(host.activeTools()).toContain("bg_bash_get");
	registerTaskTools(host.pi, runtimeState(undefined));
	tracked(startTaskControl(host.context));
	expect(host.activeTools()).toEqual(HOST_ACTIVE_TOOLS);
});

test("bg_bash_spawn tracks running tasks in the session registry", async (): Promise<void> => {
	const { host, tasks } = taskControlSession();
	const started = await toolFor(host.tools, "bg_bash_spawn").execute(
		"bash-on-demand",
		{ command: "printf task-output" },
		undefined,
		undefined,
		toolContext(),
	);
	const firstId = taskIdOf(started);
	expect(firstId).toBe("bash-1");
	expect(tasks.activeCount).toBe(1);
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));

	await tasks.wait([firstId]);
	expect(tasks.activeCount).toBe(0);
	// Boundaries do not flap or unload the tools
	host.emit("session_compact");
	expect(host.activeTools()).toEqual(expect.arrayContaining([...TASK_TOOL_IDS]));
});

test("a task that cannot start leaves active count at 0, and teardown clears the next session", (): void => {
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

test("injects background bash into deferred_tools when inactive, and into bg_bash_guidance when active", (): void => {
	const host = toolHost();
	piExtToolsExtension(host.pi);

	// Without tool_search or codemode, no deferred bullet is injected
	const startEventNone = { systemPromptOptions: { sections: {} as Record<string, string> } };
	host.emit("before_agent_start", startEventNone);
	expect(startEventNone.systemPromptOptions.sections.deferred_tools).toBeUndefined();
	expect(startEventNone.systemPromptOptions.sections.bg_bash_guidance).toBeUndefined();

	// With tool_search active, deferred bullet points to tool_search
	host.pi.setActiveTools([...host.activeTools(), "tool_search"]);
	const startEventSearch = { systemPromptOptions: { sections: {} as Record<string, string> } };
	host.emit("before_agent_start", startEventSearch);
	expect(startEventSearch.systemPromptOptions.sections.deferred_tools).toContain(
		"- background bash:",
	);
	expect(startEventSearch.systemPromptOptions.sections.deferred_tools).toContain("tool_search");
	expect(startEventSearch.systemPromptOptions.sections.bg_bash_guidance).toBeUndefined();

	// With codemode active without tool_search, deferred bullet points to codemode
	host.pi.setActiveTools(
		host
			.activeTools()
			.filter((t) => t !== "tool_search")
			.concat("codemode"),
	);
	const startEventCode = { systemPromptOptions: { sections: {} as Record<string, string> } };
	host.emit("before_agent_start", startEventCode);
	expect(startEventCode.systemPromptOptions.sections.deferred_tools).toContain(
		"- background bash:",
	);
	expect(startEventCode.systemPromptOptions.sections.deferred_tools).toContain("codemode");

	// With bg_bash_spawn active, deferred bullet is removed and full guidance injected
	host.pi.setActiveTools([...host.activeTools(), "bg_bash_spawn"]);
	const startEventActive = { systemPromptOptions: { sections: {} as Record<string, string> } };
	host.emit("before_agent_start", startEventActive);
	expect(startEventActive.systemPromptOptions.sections.deferred_tools).toBeUndefined();
	expect(startEventActive.systemPromptOptions.sections.bg_bash_guidance).toContain(
		"Use bg_bash_spawn for commands",
	);
});
