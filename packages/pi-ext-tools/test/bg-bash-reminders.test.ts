import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	BASH_HEARTBEAT_MS,
	BASH_IDLE_NOTICE_MS,
	BashJobRegistry,
	type BashJobSnapshot,
} from "../src/bash-jobs.js";
import { emitExit, type MockChild, mockChild } from "./fixtures/mock-child.js";
import { REGISTRY_TIMERS } from "./fixtures/registry-timers.js";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));

let registry: BashJobRegistry;
let children: MockChild[];

beforeEach(() => {
	// Only the registry's own scheduling is faked, so reminder timing is exact without taking the
	// event loop the doubles report on away from them.
	vi.useFakeTimers({ toFake: [...REGISTRY_TIMERS] });
	registry = new BashJobRegistry();
	children = [];
});

afterEach(async () => {
	// Let every fake process report its exit so teardown's wait is real, then use real timers.
	for (const child of children) finish(child);
	vi.useRealTimers();
	await registry.dispose();
});

function finish(child: MockChild, code = 0): void {
	if (child.exited) return;
	emitExit(child, code);
}

function start(background = true): { child: MockChild; job: BashJobSnapshot } {
	const child = mockChild();
	mocked.spawn.mockReturnValue(child);
	children.push(child);
	const job = registry.start({
		command: "build",
		cwd: process.cwd(),
		background,
		anchor: "branch-1",
	});
	return { child, job };
}

test("stdout and stderr postpone one idle notice without resetting heartbeat", () => {
	const notify = vi.fn();
	registry.onReminder(notify);
	const { child } = start();
	vi.advanceTimersByTime(BASH_IDLE_NOTICE_MS - 1);
	child.stdout.write("stdout");
	vi.advanceTimersByTime(BASH_IDLE_NOTICE_MS - 1);
	child.stderr.write("stderr");
	vi.advanceTimersByTime(BASH_IDLE_NOTICE_MS - 1);
	expect(notify).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1);
	expect(notify).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			kind: "idle",
			anchor: "branch-1",
			job: expect.objectContaining({ output: "stdoutstderr" }),
		}),
	);
	child.stdout.write("more output");
	vi.advanceTimersByTime(BASH_IDLE_NOTICE_MS * 2);
	expect(notify).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(BASH_HEARTBEAT_MS - (BASH_IDLE_NOTICE_MS * 5 - 2));
	expect(notify).toHaveBeenCalledTimes(2);
	expect(notify.mock.calls[1]?.[0].kind).toBe("heartbeat");
	vi.advanceTimersByTime(BASH_HEARTBEAT_MS);
	expect(notify).toHaveBeenCalledTimes(3);
	expect(notify.mock.calls[2]?.[0].kind).toBe("heartbeat");
});

test("stop clears reminder timers without sending another notice", () => {
	const notify = vi.fn();
	registry.onReminder(notify);
	const { job } = start();
	registry.stop(job.id);
	vi.advanceTimersByTime(BASH_HEARTBEAT_MS * 2);
	expect(notify).not.toHaveBeenCalled();
});

test("exit, spawn failure and dispose clear reminder timers", async () => {
	const notify = vi.fn();
	registry.onReminder(notify);
	const a = start();
	const b = start();
	const c = start();
	finish(a.child);
	b.child.emit("error", new Error("spawn failed"));
	const disposal = registry.dispose();
	// A fake shell never reports its own exit, so teardown's grace period is what releases it.
	await vi.advanceTimersByTimeAsync(BASH_HEARTBEAT_MS);
	await disposal;
	vi.advanceTimersByTime(BASH_HEARTBEAT_MS * 2);
	expect(notify).not.toHaveBeenCalled();
	expect(c.job.status).toBe("running");
});

test("foreground commands allocate no reminder timers", () => {
	start(false);
	expect(vi.getTimerCount()).toBe(0);
});

test("output after the process ended never reaches the finished sink", async () => {
	const notify = vi.fn();
	registry.onReminder(notify);
	const { child, job } = start();
	finish(child);
	expect(() => child.stdout.write("late")).not.toThrow();
	await registry.waitFor(job.id);
	expect(registry.pendingDeliveries().map((event) => event.id)).toEqual([job.id]);
	expect(registry.pendingDeliveries()[0]?.output).toBe("");
	expect(notify).not.toHaveBeenCalled();
});

test("reminders stop for a job that was already terminalized", () => {
	const notify = vi.fn();
	registry.onReminder(notify);
	const { child } = start();
	// The idle notice fires once, then the job finishes; the heartbeat must not report it.
	vi.advanceTimersByTime(BASH_IDLE_NOTICE_MS);
	expect(notify).toHaveBeenCalledTimes(1);
	finish(child);
	vi.advanceTimersByTime(BASH_HEARTBEAT_MS * 2);
	expect(notify).toHaveBeenCalledTimes(1);
});
