import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { agentResultText } from "@hheei/pi-ext-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BashJobRegistry } from "../src/bash-jobs.js";
import { BashExecutionLedger } from "../src/bash-ledger.js";
import { type BashSettings, DEFAULT_BASH_SETTINGS } from "../src/bash-settings.js";
import { registerBgBashTools } from "../src/bg-bash-tools.js";
import piExtToolsExtension from "../src/extension.js";
import type { ToolsRuntimeState } from "../src/session-state.js";
import { toolFor, toolHost } from "./fixtures/harness.js";
import { ledgerTemporaryDirectory } from "./fixtures/ledger-directory.js";
import { emitExit, type MockChild, mockChild } from "./fixtures/mock-child.js";
import { REGISTRY_TIMERS } from "./fixtures/registry-timers.js";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));

const registries: BashJobRegistry[] = [];
const directories: string[] = [];

// These tools are a projection of the registry, so the child is a double and only the registry's own
// delays (stop escalation, shutdown grace, timeout) are faked: the double still reports its exit in
// real event order. Real process groups and their teardown live in bash-jobs.test.ts.
beforeEach(() => {
	vi.useFakeTimers({ toFake: [...REGISTRY_TIMERS] });
});

afterEach(async () => {
	mocked.spawn.mockReset();
	try {
		for (const registry of registries.splice(0)) {
			const disposal = registry.dispose();
			// A job a test left running settles through the teardown grace, which must not cost real
			// seconds; the tests themselves report every exit they rely on.
			await vi.advanceTimersByTimeAsync(2_000);
			await disposal;
		}
	} finally {
		vi.useRealTimers();
	}
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The next spawn returns a double the test drives; nothing runs. */
function spawnOnce(): MockChild {
	const child = mockChild();
	mocked.spawn.mockReturnValueOnce(child);
	return child;
}

function tempDir(): string {
	const dir = ledgerTemporaryDirectory("hepi-bg-tools-");
	directories.push(dir);
	return dir;
}

function harness(settings?: Partial<BashSettings>): {
	readonly tools: ReturnType<typeof toolHost>["tools"];
	readonly jobs: BashJobRegistry;
} {
	const jobs = new BashJobRegistry();
	registries.push(jobs);
	const state: ToolsRuntimeState = {
		getSettings: () => ({ ...DEFAULT_BASH_SETTINGS, ...(settings ?? {}) }),
		getBashJobs: () => jobs,
	};
	const host = toolHost();
	registerBgBashTools(host.pi, state);
	return { tools: host.tools, jobs };
}

/** A tool context whose session file puts logs under a temporary directory. */
function contextFor(logDir: string, leafId: string | null = "entry-1"): ExtensionToolContext {
	return {
		cwd: process.cwd(),
		sessionManager: {
			getLeafId: () => leafId,
			getSessionId: () => "sess-1",
			getSessionFile: () => join(logDir, "session.jsonl"),
		},
		ui: { notify: (): void => undefined },
	} as unknown as ExtensionToolContext;
}

function call(
	tools: ReturnType<typeof toolHost>["tools"],
	name: string,
	args: Record<string, unknown>,
	logDir: string,
	signal?: AbortSignal,
) {
	return toolFor(tools, name).execute("call", args, signal, undefined, contextFor(logDir));
}

function spawn(
	tools: ReturnType<typeof toolHost>["tools"],
	args: Record<string, unknown>,
	logDir: string,
) {
	return call(tools, "bg_bash_spawn", args, logDir);
}

function spawned(result: Awaited<ReturnType<typeof spawn>>): { id: string; path: string } {
	return JSON.parse(agentResultText(result)) as { id: string; path: string };
}

test("historical unknown outcome exposes diagnostic by default and cannot claim a successful stop", async () => {
	const directory = tempDir();
	const ledger = new BashExecutionLedger(join(directory, "bash.sqlite"));
	ledger.save(
		{
			id: "bash-history-1",
			command: "deploy",
			purpose: "deploy",
			cwd: directory,
			status: "running",
			exitCode: null,
			startedAt: Date.now(),
			timedOut: false,
			output: "",
			truncated: false,
		},
		false,
	);
	const jobs = new BashJobRegistry(undefined, { ledger, onError: () => undefined });
	registries.push(jobs);
	const host = toolHost();
	registerBgBashTools(host.pi, {
		getSettings: () => DEFAULT_BASH_SETTINGS,
		getBashJobs: () => jobs,
	});
	const result = await call(host.tools, "bg_bash_get", { id: "bash-history-1" }, directory);
	expect(result.details).toMatchObject({
		status: "unknown",
		diagnostic: expect.stringContaining("not resumed or rerun"),
	});
	expect(result.details).not.toMatchObject({ progress: { elapsedSeconds: expect.any(Number) } });
	const stopped = await call(host.tools, "bg_bash_stop", { id: "bash-history-1" }, directory);
	expect(stopped.isError).toBe(true);
	expect(agentResultText(stopped)).toContain("unknown outcome");
	expect(agentResultText(stopped)).not.toContain("already finished");
});

test("bg_bash_spawn returns { id, path } and keeps the whole output in that log", async () => {
	const logDir = tempDir();
	const { tools, jobs } = harness();
	await expect(
		spawn(tools, { command: "printf never", id: "caller-chosen" }, logDir),
	).rejects.toThrow("Invalid bg_bash_spawn parameters");

	const child = spawnOnce();
	const started = await spawn(tools, { command: "echo task-output" }, logDir);
	const payload = spawned(started);
	expect(Object.keys(payload).sort()).toEqual(["id", "path"]);
	expect(isAbsolute(payload.path)).toBe(true);
	expect(payload.path).toBe(join(logDir, "tasks", "sess-1", `${payload.id}.log`));
	expect(started.details).toEqual(payload);
	expect(started).not.toHaveProperty("structuredContent");

	child.stdout.write("task-output\n");
	emitExit(child, 0);
	// The record is released only once its log stream closed, so the log is already complete.
	const finished = await jobs.waitFor(payload.id);
	expect(finished?.status).toBe("completed");
	expect(readFileSync(payload.path, "utf8")).toContain("task-output");

	const progress = await call(tools, "bg_bash_get", { id: payload.id, keys: "progress" }, logDir);
	expect(progress.details).toMatchObject({ progress: { path: payload.path } });
});

test("bg_bash_get projects status, progress and diagnostic without consuming the result", async () => {
	const logDir = tempDir();
	const { tools, jobs } = harness();
	const child = spawnOnce();
	const id = spawned(await spawn(tools, { command: "sleep 30" }, logDir)).id;

	expect((await call(tools, "bg_bash_get", { id, keys: "status" }, logDir)).details).toEqual({
		status: "running",
	});
	const progress = await call(tools, "bg_bash_get", { id, keys: "progress" }, logDir);
	expect(progress.details).toMatchObject({
		progress: { command: "sleep 30", cwd: process.cwd(), output: "", truncated: false },
	});
	expect(agentResultText(progress)).toContain("elapsedSeconds");

	await expect(call(tools, "bg_bash_get", { id, keys: "output" }, logDir)).rejects.toThrow(
		"Unknown bg_bash_get key",
	);
	// An empty key list falls back to the documented default instead of returning nothing.
	expect((await call(tools, "bg_bash_get", { id, keys: ",," }, logDir)).details).toMatchObject({
		status: "running",
		progress: expect.objectContaining({ command: "sleep 30" }),
	});

	await expect(call(tools, "bg_bash_get", { id: "bash-nope" }, logDir)).rejects.toThrow(
		"Background Bash task bash-nope not found",
	);

	jobs.stop(id);
	emitExit(child, null, "SIGTERM");
	expect((await jobs.waitFor(id))?.status).toBe("cancelled");
	const after = await call(
		tools,
		"bg_bash_get",
		{ id, keys: "status,progress,diagnostic" },
		logDir,
	);
	expect(after.details).toMatchObject({ status: "cancelled" });
	// A terminal result is not repeated by get: it arrives through automatic delivery instead.
	expect(after.details).not.toHaveProperty("diagnostic");
	const fields = (after.details as { progress: Record<string, unknown> }).progress;
	expect(fields).not.toHaveProperty("output");
	// Reading the record did not consume its reserved delivery.
	expect(jobs.pendingDeliveries().map((event) => event.id)).toEqual([id]);
});

test("bg_bash_get reports why a command did not succeed", async () => {
	const logDir = tempDir();
	const { tools, jobs } = harness();
	const failing = spawnOnce();
	const id = spawned(await spawn(tools, { command: "exit 3" }, logDir)).id;
	emitExit(failing, 3);
	await jobs.waitFor(id);
	expect(
		(await call(tools, "bg_bash_get", { id, keys: "diagnostic" }, logDir)).details,
	).toMatchObject({ diagnostic: "Command exited with code 3" });

	const slow = spawnOnce();
	const timedOut = spawned(await spawn(tools, { command: "sleep 30", timeout: 0.05 }, logDir)).id;
	// The timeout asks the shell to stop; its own exit decides the record.
	await vi.advanceTimersByTimeAsync(50);
	emitExit(slow, null, "SIGTERM");
	const finished = await jobs.waitFor(timedOut);
	expect(finished?.status).toBe("timed_out");
	expect(
		(await call(tools, "bg_bash_get", { id: timedOut, keys: "diagnostic" }, logDir)).details,
	).toEqual({ diagnostic: "Command timed out" });
});

test("bg_bash_stop waits for the process to exit before reporting", async () => {
	const logDir = tempDir();
	const { tools, jobs } = harness();
	const child = spawnOnce();
	const id = spawned(await spawn(tools, { command: "sleep 30" }, logDir)).id;

	const stopping = call(tools, "bg_bash_stop", { id }, logDir);
	// The confirmation is held open until the process reports the exit the stop asked for.
	await vi.advanceTimersByTimeAsync(0);
	expect(jobs.get(id)?.status).toBe("stopping");
	emitExit(child, null, "SIGTERM");
	const stopped = await stopping;
	expect(stopped.content).toEqual([{ type: "text", text: `Stopped ${id}.` }]);
	expect(stopped.details).toBeUndefined();
	// The confirmation came after the process reported its exit, not after the signal was sent.
	expect(jobs.get(id)?.status).toBe("cancelled");
	expect(jobs.pendingDeliveries().map((event) => event.id)).toEqual([id]);

	const again = await call(tools, "bg_bash_stop", { id }, logDir);
	expect(again.content).toEqual([{ type: "text", text: `Job ${id} already finished.` }]);

	await expect(call(tools, "bg_bash_stop", { id: "bash-missing" }, logDir)).rejects.toThrow(
		"Background Bash task bash-missing not found",
	);
});

test("an interrupted stop gives up waiting but leaves the stop running", async () => {
	const logDir = tempDir();
	const { tools, jobs } = harness();
	const child = spawnOnce();
	const id = spawned(await spawn(tools, { command: "sleep 30" }, logDir)).id;

	const controller = new AbortController();
	const waiting = call(tools, "bg_bash_stop", { id }, logDir, controller.signal);
	// Cancel before the process reports its exit: the call ends, the kill keeps running.
	controller.abort();
	await expect(waiting).rejects.toThrow("was interrupted");
	// The registry still stops the process the caller left behind.
	emitExit(child, null, "SIGTERM");
	const finished = await jobs.waitFor(id);
	expect(finished?.status).toBe("cancelled");
});

test("background Bash controls report an unavailable session instead of guessing", async () => {
	const logDir = tempDir();
	const host = toolHost();
	registerBgBashTools(host.pi, {
		getSettings: () => DEFAULT_BASH_SETTINGS,
		getBashJobs: () => undefined,
	});
	const unavailable = await toolFor(host.tools, "bg_bash_spawn").execute(
		"call",
		{ command: "echo" },
		undefined,
		undefined,
		contextFor(logDir),
	);
	expect(unavailable).toMatchObject({ isError: true });
	expect(agentResultText(unavailable)).toContain("unavailable outside active session");
	for (const name of ["bg_bash_get", "bg_bash_stop"]) {
		await expect(
			toolFor(host.tools, name).execute(
				"call",
				{ id: "bash-1" },
				undefined,
				undefined,
				contextFor(logDir),
			),
		).rejects.toThrow("No active background Bash session");
	}
});

test("a disposed registry refuses to start work and the reason reaches the caller", async () => {
	const logDir = tempDir();
	const { tools, jobs } = harness();
	await jobs.dispose();
	const result = await spawn(tools, { command: "printf never" }, logDir);
	expect(result.content).toEqual([
		{ type: "text", text: "Unable to start background job: Bash job registry is disposed" },
	]);
	expect(result.details).toBeUndefined();
	expect(result).toMatchObject({ isError: true });
});

test("the whole log directory is created for the session, not for a caller-chosen name", async () => {
	const logDir = tempDir();
	const { tools, jobs } = harness();
	const one = spawnOnce();
	const two = spawnOnce();
	const first = spawned(await spawn(tools, { command: "echo one" }, logDir));
	const second = spawned(await spawn(tools, { command: "echo two" }, logDir));
	expect(first.path).not.toBe(second.path);
	one.stdout.write("one\n");
	emitExit(one, 0);
	two.stdout.write("two\n");
	emitExit(two, 0);
	await Promise.all([jobs.waitFor(first.id), jobs.waitFor(second.id)]);
	expect(readFileSync(first.path, "utf8")).toBe("one\n");
	expect(readFileSync(second.path, "utf8")).toBe("two\n");
});

test("spawned jobs keep their branch anchor for delivery", async () => {
	const logDir = tempDir();
	const { tools, jobs } = harness();
	const first = spawnOnce();
	const second = spawnOnce();
	const id = spawned(await spawn(tools, { command: "sleep 30" }, logDir)).id;
	const anchored = spawned(
		await call(tools, "bg_bash_spawn", { command: "sleep 30" }, join(logDir, "other")),
	);
	expect(anchored.id).not.toBe(id);
	jobs.stop(id);
	emitExit(first, null, "SIGTERM");
	await jobs.waitFor(id);
	// The second job finished on its own, so both records reach a real terminal status.
	emitExit(second, 0);
	await jobs.waitFor(anchored.id);
	expect(jobs.pendingDeliveries().find((event) => event.id === id)?.anchor).toBe("entry-1");
});

test("background Bash stays a deferred optional tool family", () => {
	const host = toolHost();
	piExtToolsExtension(host.pi);
	const names = host.tools
		.filter((tool) => tool.name.startsWith("bg_bash_"))
		.map((tool) => tool.name);
	expect(names).toEqual(["bg_bash_spawn", "bg_bash_get", "bg_bash_stop"]);
	for (const tool of host.tools.filter((candidate) => candidate.name.startsWith("bg_bash_"))) {
		expect(tool.exposure).toBe("deferred");
		expect(tool.defaultActive).toBe(false);
	}
	const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
	host.emit("before_agent_start", event);
	expect(event.systemPromptOptions.sections.optional_tools).toContain(
		'- background bash (query: "bg_bash"): Run long-running shell commands in background',
	);
});
