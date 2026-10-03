/**
 * The child Pi process a parent Pi spawns directly.
 *
 * A background child has no terminal and no supervisor, so the parent that started it is also what
 * ends it: the process is held open through stdin (never written to) and its output is drained
 * rather than parsed, because the bridge is the control plane and stdio is plumbing.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { errorMessage } from "@hheei/pi-ext-core";

export const DEFAULT_TERMINATE_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;

export interface ChildProcessOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly diagnose?: (message: string) => void;
}

export interface ChildRuntime {
	readonly pid: number | undefined;
	readonly alive: boolean;
	/** Resolves when the process is gone; a signal death reports a null code. */
	readonly exited: Promise<number | null>;
	/** SIGTERM, then SIGKILL after the grace window. Idempotent. */
	terminate(graceMs?: number): Promise<void>;
}

function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Live handles are held for the lifetime of this process. A background child is held open by the
 * write end of its stdin, so dropping the handle early (an extension reload, a garbage collection)
 * would send it an EOF and end a child that only its parent's exit is supposed to end.
 */
const retained = new Set<ChildProcess>();

/**
 * Starts a detached-from-the-terminal child Pi. The caller keeps the handle: this package has no
 * supervisor process, so nothing else can end a background child after its parent is gone.
 */
export function spawnChildRuntime(options: ChildProcessOptions): ChildRuntime {
	const diagnose = options.diagnose ?? ((): void => {});
	const child = spawn(options.command, [...options.args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	// Node reports a failed spawn asynchronously, so the listener is attached before anything else:
	// a command that never started must not surface as an unhandled 'error' event.
	const exited = new Promise<number | null>((resolve) => {
		child.once("error", (error) => {
			diagnose(`child process error: ${errorMessage(error)}`);
			resolve(null);
		});
		child.once("exit", (code, signal) => {
			retained.delete(child);
			if (signal !== null) diagnose(`child process exited on ${signal}`);
			resolve(code);
		});
	});
	if (child.pid === undefined) {
		child.kill("SIGKILL");
		throw new Error(`Child process ${options.command} did not start`);
	}
	retained.add(child);
	// stdout is the child's Pi protocol stream and stderr its diagnostics; neither is a control
	// channel, so they are drained to keep the pipes from filling and reported only as diagnostics.
	child.stdout.on("data", () => {});
	child.stderr.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8").trim();
		if (text !== "") diagnose(text);
	});
	child.stdin.on("error", () => {});
	return {
		pid: child.pid,
		get alive(): boolean {
			return !hasExited(child);
		},
		exited,
		async terminate(graceMs = DEFAULT_TERMINATE_GRACE_MS): Promise<void> {
			if (hasExited(child)) return;
			child.kill("SIGTERM");
			if (await settled(exited, graceMs)) return;
			diagnose(`child process ${child.pid} ignored SIGTERM; sending SIGKILL`);
			child.kill("SIGKILL");
			if (!(await settled(exited, DEFAULT_KILL_GRACE_MS))) {
				diagnose(`child process ${child.pid} did not exit after SIGKILL`);
			}
		},
	};
}

/** True when `work` settled within the window; the child process outlives this wait either way. */
function settled(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		timer.unref?.();
		void work.then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			() => {
				clearTimeout(timer);
				resolve(true);
			},
		);
	});
}
