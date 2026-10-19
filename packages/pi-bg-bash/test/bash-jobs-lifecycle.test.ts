import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	BashJobRegistry,
	MAX_PENDING_BASH_JOBS,
	MAX_RETAINED_BASH_JOBS,
} from "../src/bash-jobs.js";
import { ledgerTemporaryDirectory } from "./fixtures/ledger-directory.js";
import { emitExit, type MockChild, mockChild } from "./fixtures/mock-child.js";
import { REGISTRY_TIMERS } from "./fixtures/registry-timers.js";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));

const registries: BashJobRegistry[] = [];
const directories: string[] = [];

// Only the registry's own scheduling is faked, so the child doubles keep emitting on the real
// event loop and a real `setImmediate` still means "this turn".
beforeEach(() => {
	vi.useFakeTimers({ toFake: [...REGISTRY_TIMERS] });
});

afterEach(async () => {
	vi.useRealTimers();
	mocked.spawn.mockReset();
	for (const current of registries.splice(0)) await current.dispose();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function registry(tailBytes?: number): BashJobRegistry {
	const created = new BashJobRegistry(tailBytes);
	registries.push(created);
	return created;
}

function tempDirectory(prefix: string): string {
	const directory = ledgerTemporaryDirectory(prefix);
	directories.push(directory);
	return directory;
}

/** The next `spawn` call returns a double the test controls. */
function spawnOnce(): MockChild {
	const runtime = mockChild();
	mocked.spawn.mockReturnValueOnce(runtime);
	return runtime;
}

test("a synchronous spawn failure leaves no running record or open log", async () => {
	const jobs = registry();
	const dir = tempDirectory("hepi-bash-spawnthrow-");
	const logPath = join(dir, "throw.log");
	// A NUL byte passes the tool schema but the platform rejects it before any process exists.
	mocked.spawn.mockImplementationOnce(() => {
		throw new Error("ERR_INVALID_ARG_VALUE: command contains a NUL byte");
	});
	expect(() =>
		jobs.start({
			command: "bad\u0000command",
			cwd: process.cwd(),
			background: true,
			logPath,
		}),
	).toThrow("NUL");
	// Nothing was reserved: the caller received the failure directly.
	expect(jobs.pendingDeliveries()).toEqual([]);
	// The record was dropped instead of staying behind as a phantom running job.
	const runtime = spawnOnce();
	const next = jobs.start({ command: "true", cwd: process.cwd(), background: true });
	expect(next.status).toBe("running");
	emitExit(runtime, 0);
	await jobs.waitFor(next.id);
	expect(jobs.pendingDeliveries().map((event) => event.id)).toEqual([next.id]);
});

test("honors an async timeout and reserves exactly one result", async () => {
	const jobs = registry();
	const runtime = spawnOnce();
	const started = jobs.start({
		command: "sleep 10",
		cwd: process.cwd(),
		timeoutMs: 25,
		background: true,
	});
	await vi.advanceTimersByTimeAsync(25);
	// The timeout asks the shell to stop; its own exit decides the record.
	emitExit(runtime, null, "SIGTERM");
	const finished = await jobs.waitFor(started.id);
	expect(finished?.timedOut).toBe(true);
	expect(finished?.status).toBe("timed_out");
	expect(jobs.pendingDeliveries().map((event) => event.id)).toEqual([started.id]);
});

test("stop is idempotent and never revives a finished job", async () => {
	const jobs = registry();
	const runtime = spawnOnce();
	const started = jobs.start({ command: "sleep 5", cwd: process.cwd(), background: true });
	expect(jobs.stop(started.id)?.status).toBe("stopping");
	expect(jobs.stop(started.id)?.status).toBe("stopping");
	emitExit(runtime, null, "SIGTERM");
	const finished = await jobs.waitFor(started.id);
	expect(finished?.status).toBe("cancelled");
	expect(jobs.stop(started.id)?.status).toBe("cancelled");
	expect(jobs.pendingDeliveries()).toHaveLength(1);
});

test("a late close does not deliver the same result twice", async () => {
	const jobs = registry();
	const runtime = spawnOnce();
	const started = jobs.start({ command: "echo twice", cwd: process.cwd(), background: true });
	runtime.stdout.write("twice\n");
	emitExit(runtime, 0);
	await jobs.waitFor(started.id);
	const announced = (): number =>
		jobs.pendingDeliveries().filter((event) => event.id === started.id).length;
	expect(announced()).toBe(1);
	// A second close from a shell that already reported its exit is not a second result.
	emitExit(runtime, 0);
	await vi.advanceTimersByTimeAsync(60);
	expect(announced()).toBe(1);
});

test("waitFor keeps running work alive when the wait is cancelled", async () => {
	const jobs = registry();
	const runtime = spawnOnce();
	const started = jobs.start({ command: "watch", cwd: process.cwd(), background: true });
	const controller = new AbortController();
	const pending = jobs.waitFor(started.id, controller.signal);
	controller.abort();
	expect(await pending).toBeUndefined();
	expect(jobs.get(started.id)?.status).toBe("running");
	jobs.stop(started.id);
	emitExit(runtime, null, "SIGTERM");
	expect((await jobs.waitFor(started.id))?.status).toBe("cancelled");
});

test("a log the platform refuses before the stream exists is reported and leaves the job running", async () => {
	const jobs = registry();
	const runtime = spawnOnce();
	const started = jobs.start({
		command: "echo logged",
		cwd: process.cwd(),
		background: true,
		// A NUL byte passes the tool schema but the platform refuses the path, so no stream was
		// ever created to carry the output.
		logPath: "/nonexistent-directory/\u0000pi-ext-tools.log",
	});
	const flagged = jobs.get(started.id);
	expect(flagged?.status).toBe("running");
	expect(flagged?.logError).toContain("path");
	// The open failure is named in the streamed output, not only in the later delivery.
	expect(flagged?.output).toContain("log unavailable");
	emitExit(runtime, 0);
	const finished = await jobs.waitFor(started.id);
	expect(finished?.status).toBe("completed");
	expect(jobs.pendingDeliveries()[0]?.logError).toBeTypeOf("string");
});

test("a log directory that cannot be opened fails the record with the stream error", async () => {
	const jobs = registry();
	const runtime = spawnOnce();
	const started = jobs.start({
		command: "echo logged",
		cwd: process.cwd(),
		background: true,
		// The stream is created, but reports its open failure asynchronously.
		logPath: "/nonexistent-directory/pi-ext-tools/log.log",
	});
	emitExit(runtime, 0);
	// The record is released only after the log stream reported its failure, so waiting for the
	// result is also waiting for the diagnosis.
	const finished = await jobs.waitFor(started.id);
	expect(finished?.status).toBe("completed");
	expect(finished?.logError).toContain("ENOENT");
	expect(jobs.pendingDeliveries()[0]?.logError).toContain("ENOENT");
});

test("cleanly terminalizes when the command exits but a descendant holds stdio open", async () => {
	const jobs = registry();
	const runtime = spawnOnce();
	const started = jobs.start({
		command: "python3 -c 'import time; time.sleep(10)' 1>&2 & exit 0",
		cwd: process.cwd(),
		background: true,
	});
	// The shell exits while its stdio stays open, so only the drain deadline can end the record.
	runtime.emit("exit", 0, null);
	expect(jobs.get(started.id)?.status).toBe("running");
	await vi.advanceTimersByTimeAsync(1_000);
	const finished = await jobs.waitFor(started.id);
	expect(finished?.status).toBe("completed");
});

test("protects unconfirmed results and bounds the records already confirmed", async () => {
	const jobs = registry(1024);
	const run = async (count: number): Promise<string[]> => {
		const ids: string[] = [];
		for (let index = 0; index < count; index += 1) {
			const runtime = spawnOnce();
			const started = jobs.start({
				command: `echo result-${String(index)}`,
				cwd: process.cwd(),
				background: true,
			});
			ids.push(started.id);
			runtime.stdout.write(`result-${String(index)}\n`);
			emitExit(runtime, 0);
		}
		await Promise.all(ids.map((id) => jobs.waitFor(id)));
		return ids;
	};
	const first = await run(MAX_PENDING_BASH_JOBS);
	// Nothing was confirmed, so no result may be evicted: each is the only copy the model can get.
	expect(jobs.pendingDeliveries()).toHaveLength(first.length);
	jobs.markSubmitted(first, "batch-1");
	expect(jobs.pendingDeliveries()).toHaveLength(0);
	// Submitted but unconfirmed records are still protected.
	expect(jobs.get(first[0] ?? "")).toBeDefined();
	jobs.markRecorded("batch-1");

	const second = await run(20);
	jobs.markSubmitted(second, "batch-2");
	jobs.markRecorded("batch-2");
	const retained = [...first, ...second].filter((id) => jobs.get(id) !== undefined);
	expect(retained.length).toBeLessThanOrEqual(MAX_RETAINED_BASH_JOBS);
	// Eviction takes the oldest confirmed records, so no unconfirmed result was ever dropped and
	// every still-reserved result stays readable.
	expect(retained.slice(-second.length)).toEqual(second);
	expect(jobs.pendingDeliveries()).toHaveLength(0);
});

test("refuses new background work once running and unconfirmed results fill the budget", async () => {
	const jobs = registry(1024);
	for (let index = 0; index < MAX_PENDING_BASH_JOBS; index += 1) {
		const runtime = spawnOnce();
		const started = jobs.start({ command: "true", cwd: process.cwd(), background: true });
		emitExit(runtime, 0);
		await jobs.waitFor(started.id);
	}
	// Every result is still undelivered, so it keeps its reservation.
	expect(() => jobs.start({ command: "true", cwd: process.cwd(), background: true })).toThrow(
		"capacity is full",
	);
	// Foreground calls report inline and are never blocked by background capacity.
	const inline = spawnOnce();
	const started = jobs.start({ command: "true", cwd: process.cwd() });
	expect(started.status).toBe("running");
	emitExit(inline, 0);
	await jobs.waitFor(started.id);
});

test("dispose stops owned processes, waits for their exit, and is idempotent", async () => {
	const jobs = registry();
	const runtime = spawnOnce();
	const started = jobs.start({
		command: "watch",
		cwd: process.cwd(),
		background: true,
	});
	const waitPromise = jobs.waitFor(started.id);
	const disposal = jobs.dispose();
	// The stop asks the shell to exit, but the record is not released until the exit is observed.
	expect(runtime.kill).toHaveBeenCalledTimes(1);
	let settled = false;
	void disposal.then(() => {
		settled = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(settled).toBe(false);
	emitExit(runtime, null, "SIGTERM");
	await disposal;
	const snapshot = await waitPromise;
	expect(snapshot?.status).toBe("cancelled");
	expect(typeof snapshot?.endedAt).toBe("number");
	expect(jobs.get(started.id)).toBeUndefined();
	await expect(jobs.dispose()).resolves.toBeUndefined();
	expect(() => jobs.start({ command: "true", cwd: process.cwd() })).toThrow("disposed");
});

test("a released record already flushed its log before the result was reported", async () => {
	const jobs = registry();
	const directory = tempDirectory("hepi-bash-lifecycle-flush-");
	const runtime = spawnOnce();
	const started = jobs.start({
		command: "echo flushed",
		cwd: process.cwd(),
		background: true,
		resolveLogPath: (id) => join(directory, `${id}.log`),
	});
	runtime.stdout.write("flushed\n");
	emitExit(runtime, 0);
	const finished = await jobs.waitFor(started.id);
	// The delivery names this path, so waiting for the record implies the file was closed.
	expect(readFileSync(finished?.logPath ?? "", "utf8")).toBe("flushed\n");
});
