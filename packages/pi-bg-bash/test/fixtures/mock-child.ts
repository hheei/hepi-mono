import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

/**
 * A spawned-process double for the suites that replace `node:child_process.spawn`.
 *
 * The double reports no pid, so a stop reaches `kill()` on it instead of a real process group: a
 * made-up pid would address whichever unrelated group that number happens to be on the machine
 * running the suite. It is therefore a registry-semantics double: the test drives stdout, stderr and
 * the exit/close pair, exactly as with a real child, but nothing runs.
 */
export function mockChild() {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => true),
		pid: undefined,
		killed: false,
		exited: false,
		exitCode: null as number | null,
	});
}

export type MockChild = ReturnType<typeof mockChild>;

/** The exit pair a real child reports, in the order the registry consumes it. */
export function emitExit(
	child: MockChild,
	code: number | null,
	signal: string | null = null,
): void {
	child.exited = true;
	child.exitCode = code;
	child.emit("exit", code, signal);
	child.emit("close", code, signal);
}
