import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BASH_HEARTBEAT_MS, BASH_IDLE_NOTICE_MS, BashJobRegistry } from "../src/bash-jobs.js";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));

let registry: BashJobRegistry;

beforeEach(() => {
	vi.useFakeTimers();
	registry = new BashJobRegistry();
});

afterEach(() => {
	registry.dispose();
	vi.useRealTimers();
});

function start(reminders = true) {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
		pid: undefined,
		killed: false,
		exitCode: null,
	});
	mocked.spawn.mockReturnValue(child);
	const job = registry.start({
		id: "bash-1",
		command: "build",
		cwd: process.cwd(),
		reminders,
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
			job: expect.objectContaining({ id: "bash-1", output: "stdoutstderr" }),
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

test.each(["stop", "complete", "error", "dispose"])("%s clears reminder timers", (action) => {
	const notify = vi.fn();
	registry.onReminder(notify);
	const { child, job } = start();
	if (action === "stop") registry.stop(job.id);
	if (action === "dispose") registry.dispose();
	if (action === "error") child.emit("error", new Error("spawn failed"));
	if (action === "complete") {
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
	}
	vi.advanceTimersByTime(BASH_HEARTBEAT_MS * 2);
	expect(notify).not.toHaveBeenCalled();
});

test("foreground jobs do not allocate reminder timers", () => {
	start(false);
	expect(vi.getTimerCount()).toBe(0);
});
