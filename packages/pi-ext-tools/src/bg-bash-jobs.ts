import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { TaskProgress, TaskRegistry, TaskSnapshot, TaskTerminal } from "@hheei/pi-ext-core";
import { BashOutputSink } from "./bash-output.js";

export const MAX_JOB_OUTPUT = 1024 * 1024;
export const BASH_IDLE_NOTICE_MS = 180_000;
export const BASH_HEARTBEAT_MS = 1_800_000;

export interface BashJobReminder {
	readonly kind: "idle" | "heartbeat";
	readonly job: BashJobSnapshot;
	readonly anchor?: string;
}

/**
 * Signals a whole job tree, not just its shell.
 *
 * A stopped POSIX job is a process group, so the group signal reaches every descendant. Windows has
 * no process groups: `child.kill()` terminates `cmd.exe` and orphans everything it started, which is
 * why the tree goes through `taskkill`. There is no graceful step to try first there, because
 * terminating the shell is what breaks the parent chain `taskkill` walks.
 */
function killProcessTree(pid: number): void {
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Both the group and the shell are already gone.
			}
		}
		return;
	}
	const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
	const killer = spawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
		stdio: "ignore",
		detached: true,
		windowsHide: true,
	});
	// A failed spawn reports asynchronously; consume it so it cannot crash the session.
	killer.once("error", () => {});
}

export interface BashJobRequest {
	readonly id?: string;
	readonly reminders?: boolean;
	readonly anchor?: string;
	readonly command: string;
	readonly cwd: string;
	readonly shellPath?: string;
	readonly timeoutMs?: number;
	readonly logPath?: string;
	/** Optional real-time stream callback receiving raw output chunks. */
	readonly onData?: (data: Buffer) => void;
	/** Called once when the job reaches a terminal state and the registry is still open. */
	readonly onTerminal?: (job: BashJobSnapshot) => void;
}

/** Task registration request for `BashJobRegistry.startAsTask`. */
export interface BashTaskRequest {
	readonly command: string;
	readonly cwd: string;
	readonly shellPath: string;
	readonly timeoutMs?: number;
	readonly logPath?: string;
	readonly resolveLogPath?: (taskId: string) => string;
	/** Branch marker captured when the command started. */
	readonly anchor?: string;
}

const MAX_PURPOSE_CHARS = 200;

/** One-line intent shown in job listings and terminal deliveries. */
export function bashJobPurpose(command: string): string {
	const line =
		command
			.split("\n")
			.find((candidate) => candidate.trim() !== "")
			?.trim() ?? "";
	if (line === "") return "background command";
	return line.length > MAX_PURPOSE_CHARS ? `${line.slice(0, MAX_PURPOSE_CHARS)}…` : line;
}

function terminalFrom(job: BashJobSnapshot): TaskTerminal {
	return {
		status: job.timedOut
			? "timed_out"
			: job.status === "completed"
				? "completed"
				: job.status === "stopped"
					? "cancelled"
					: "failed",
		output: job.output,
		truncated: job.truncated,
		detail: {
			jobId: job.id,
			exitCode: job.exitCode,
			...(job.logPath !== undefined ? { logPath: job.logPath } : {}),
			...(job.timedOut ? { timedOut: true } : {}),
		},
	};
}

export interface BashJobSnapshot {
	readonly id: string;
	readonly command: string;
	readonly cwd: string;
	readonly status: "running" | "completed" | "failed" | "stopped";
	readonly exitCode: number | null;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly output: string;
	readonly truncated: boolean;
	readonly logPath?: string;
	/** True only when this registry stopped the job after its requested timeout. */
	readonly timedOut: boolean;
	readonly diagnostic?: string;
}

interface Job {
	idleTimer?: NodeJS.Timeout | undefined;
	heartbeatTimer?: NodeJS.Timeout | undefined;
	idleNotified: boolean;
	reminders: boolean;
	anchor?: string;
	diagnostic?: string;
	id: string;
	command: string;
	cwd: string;
	status: BashJobSnapshot["status"];
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	timedOut: boolean;
	logPath?: string | undefined;
	logStream?: WriteStream | undefined;
	process?: ChildProcess;
	outputSink: BashOutputSink;
	timeout?: NodeJS.Timeout | undefined;
	cleanupTimer?: NodeJS.Timeout | undefined;
	terminalized: boolean;
	onTerminal?: (job: BashJobSnapshot) => void;
	waiter: ((snapshot: BashJobSnapshot) => void) | undefined;
}
export function defaultShellPath(): string {
	return process.platform === "win32"
		? (process.env.ComSpec ?? "cmd.exe")
		: (process.env.SHELL ?? "/bin/sh");
}
function snapshot(job: Job): BashJobSnapshot {
	const output = job.outputSink.snapshot();
	return {
		id: job.id,
		command: job.command,
		cwd: job.cwd,
		status: job.status,
		exitCode: job.exitCode,
		startedAt: job.startedAt,
		timedOut: job.timedOut,
		...(job.diagnostic === undefined ? {} : { diagnostic: job.diagnostic }),
		...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
		output: output.output,
		truncated: output.truncated,
		...(job.logPath === undefined ? {} : { logPath: job.logPath }),
	};
}

export class BgBashJobRegistry {
	readonly #jobs = new Map<string, Job>();
	readonly #reminderListeners = new Set<(event: BashJobReminder) => void>();
	#closed: boolean = false;
	readonly #tailBytes: number | undefined;
	constructor(tailBytes?: number) {
		this.#tailBytes = tailBytes;
	}
	start(request: BashJobRequest): BashJobSnapshot {
		if (this.#closed) throw new Error("Bash job registry is disposed");
		const outputSink = new BashOutputSink(this.#tailBytes);
		const id = request.id ?? crypto.randomUUID();
		if (this.#jobs.has(id)) throw new Error(`Bash job ${id} already exists`);
		let logStream: WriteStream | undefined;
		let effectiveLogPath = request.logPath;
		if (request.logPath !== undefined) {
			try {
				logStream = createWriteStream(request.logPath, { flags: "a" });
				logStream.on("error", () => {
					effectiveLogPath = undefined;
					logStream = undefined;
				});
			} catch {
				effectiveLogPath = undefined;
			}
		}
		const job: Job = {
			idleNotified: false,
			reminders: request.reminders === true,
			...(request.anchor === undefined ? {} : { anchor: request.anchor }),
			id,
			command: request.command,
			cwd: request.cwd,
			status: "running",
			exitCode: null,
			startedAt: Date.now(),
			timedOut: false,
			logPath: effectiveLogPath,
			logStream,
			outputSink,
			terminalized: false,
			waiter: undefined,
			...(request.onTerminal === undefined ? {} : { onTerminal: request.onTerminal }),
		};
		const shellPath = request.shellPath ?? defaultShellPath();
		const child = spawn(
			shellPath,
			process.platform === "win32" ? ["/d", "/s", "/c", request.command] : ["-c", request.command],
			{
				cwd: request.cwd,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		job.process = child;
		child.stdout?.on("data", (data: Buffer) => {
			if (!this.#closed) {
				job.outputSink.push(data);
				this.#resetIdleTimer(job);
				if (job.logStream && !job.logStream.write(data)) {
					child.stdout?.pause();
					job.logStream.once("drain", () => child.stdout?.resume());
				}
				request.onData?.(data);
			}
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (!this.#closed) {
				job.outputSink.push(data);
				this.#resetIdleTimer(job);
				if (job.logStream && !job.logStream.write(data)) {
					child.stderr?.pause();
					job.logStream.once("drain", () => child.stderr?.resume());
				}
				request.onData?.(data);
			}
		});
		child.once("error", (error) => {
			if (job.status === "running") {
				const messageBuf = Buffer.from(`${error.message}\n`);
				if (!this.#closed) {
					job.outputSink.push(messageBuf);
					request.onData?.(messageBuf);
				}
				job.status = "failed";
				job.diagnostic = error.message;
				job.endedAt = Date.now();
			}
			// `close` usually follows a spawn failure, but a post-spawn error may not report one.
			this.#terminalize(job, !this.#closed);
		});
		child.once("exit", (code, signal) => {
			this.#clearReminders(job);
			clearTimeout(job.timeout);
			if (job.status === "running") {
				job.exitCode = code;
				job.status = signal ? "stopped" : code === 0 ? "completed" : "failed";
				job.endedAt = Date.now();
			}
			// If stdio streams do not close shortly after process exit (e.g. grandchildren inherited stdio),
			// destroy the streams so close fires and the job does not hang indefinitely.
			job.cleanupTimer ??= setTimeout(() => {
				if (!job.terminalized) {
					child.stdout?.destroy();
					child.stderr?.destroy();
					this.#terminalize(job, !this.#closed);
				}
			}, 1000);
			job.cleanupTimer.unref();
		});
		child.once("close", (code, signal) => {
			clearTimeout(job.timeout);
			if (job.cleanupTimer !== undefined) {
				clearTimeout(job.cleanupTimer);
				job.cleanupTimer = undefined;
			}
			if (job.status === "running") {
				job.exitCode = code;
				job.status = signal ? "stopped" : code === 0 ? "completed" : "failed";
				job.endedAt = Date.now();
			}
			this.#terminalize(job, !this.#closed);
		});
		if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
			job.timeout = setTimeout(() => {
				job.timedOut = true;
				this.stop(id);
			}, request.timeoutMs);
		}
		this.#jobs.set(id, job);
		if (job.reminders) {
			this.#resetIdleTimer(job);
			job.heartbeatTimer = setInterval(() => this.#remind(job, "heartbeat"), BASH_HEARTBEAT_MS);
			job.heartbeatTimer.unref();
		}
		return snapshot(job);
	}

	/**
	 * Starts one background Bash job and registers it as an observable task.
	 *
	 * The registry owns the task wiring: the job id equals the task id, terminal snapshots settle the
	 * task, and the returned binding routes stop/describe back to this registry.
	 */
	startAsTask(
		tasks: TaskRegistry,
		request: BashTaskRequest,
	): { task: TaskSnapshot; logPath?: string | undefined } {
		let resolvedLogPath = request.logPath;
		const task = tasks.create({
			type: "bash",
			purpose: bashJobPurpose(request.command),
			...(request.anchor === undefined ? {} : { anchor: request.anchor }),
			begin: (taskId: string) => {
				if (resolvedLogPath === undefined && request.resolveLogPath !== undefined) {
					resolvedLogPath = request.resolveLogPath(taskId);
				}
				const job = this.start({
					id: taskId,
					reminders: true,
					...(request.anchor === undefined ? {} : { anchor: request.anchor }),
					command: request.command,
					cwd: request.cwd,
					shellPath: request.shellPath,
					...(resolvedLogPath !== undefined ? { logPath: resolvedLogPath } : {}),
					...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
					onTerminal: (finished): void => {
						tasks.settle(taskId, terminalFrom(finished));
					},
				});
				return {
					stop: (): void => {
						this.stop(job.id);
					},
					describe: (): TaskProgress => {
						const current = this.get(job.id);
						return {
							output: current?.output ?? "",
							truncated: current?.truncated ?? false,
						};
					},
				};
			},
		});
		return { task, ...(resolvedLogPath === undefined ? {} : { logPath: resolvedLogPath }) };
	}
	onReminder(listener: (event: BashJobReminder) => void): () => void {
		this.#reminderListeners.add(listener);
		return () => this.#reminderListeners.delete(listener);
	}
	#remind(job: Job, kind: BashJobReminder["kind"]): void {
		if (this.#closed || job.status !== "running" || job.terminalized) return;
		const event = {
			kind,
			job: snapshot(job),
			...(job.anchor === undefined ? {} : { anchor: job.anchor }),
		};
		for (const listener of this.#reminderListeners) listener(event);
	}
	#resetIdleTimer(job: Job): void {
		if (!job.reminders || job.idleNotified || job.status !== "running") return;
		if (job.idleTimer !== undefined) {
			job.idleTimer.refresh();
			return;
		}
		job.idleTimer = setTimeout(() => {
			job.idleTimer = undefined;
			job.idleNotified = true;
			this.#remind(job, "idle");
		}, BASH_IDLE_NOTICE_MS);
		job.idleTimer.unref();
	}
	#clearReminders(job: Job): void {
		clearTimeout(job.idleTimer);
		clearInterval(job.heartbeatTimer);
		job.idleTimer = undefined;
		job.heartbeatTimer = undefined;
	}
	#terminalize(job: Job, notify: boolean): void {
		this.#clearReminders(job);
		clearTimeout(job.timeout);
		if (job.terminalized) return;
		job.terminalized = true;
		if (job.cleanupTimer !== undefined) {
			clearTimeout(job.cleanupTimer);
			job.cleanupTimer = undefined;
		}
		const stream = job.logStream;
		job.logStream = undefined;
		job.outputSink.finish();
		const finalSnapshot = snapshot(job);
		const notifyTerminal = (): void => {
			const waiter = job.waiter;
			job.waiter = undefined;
			waiter?.(finalSnapshot);
			if (!notify) return;
			job.onTerminal?.(finalSnapshot);
		};
		if (stream !== undefined && !stream.writableFinished) {
			let done = false;
			const finish = (): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				notifyTerminal();
			};
			const timer = setTimeout(finish, 1000);
			timer.unref();
			stream.once("finish", finish);
			stream.once("close", finish);
			stream.once("error", finish);
			stream.end();
		} else {
			stream?.end();
			notifyTerminal();
		}
	}
	/** Binds the terminal callback for one job, replacing any previous one. */
	bindTerminal(id: string, onTerminal: (job: BashJobSnapshot) => void): void {
		const job = this.#jobs.get(id);
		if (!job) return;
		job.onTerminal = onTerminal;
		if (job.terminalized) onTerminal(snapshot(job));
	}
	waitFor(id: string): Promise<BashJobSnapshot | undefined> {
		const job = this.#jobs.get(id);
		if (!job) return Promise.resolve(undefined);
		if (job.terminalized) return Promise.resolve(snapshot(job));
		return new Promise<BashJobSnapshot | undefined>((resolve) => {
			job.waiter = resolve;
		});
	}
	get(id: string): BashJobSnapshot | undefined {
		const job = this.#jobs.get(id);
		return job && snapshot(job);
	}
	stop(id: string): BashJobSnapshot | undefined {
		const job = this.#jobs.get(id);
		if (!job) return undefined;
		if (job.status !== "running") return snapshot(job);
		this.#clearReminders(job);
		job.status = "stopped";
		job.endedAt = Date.now();
		const child = job.process;
		clearTimeout(job.timeout);
		if (child && !child.killed) {
			const pid = child.pid;
			if (process.platform === "win32") {
				if (pid === undefined) child.kill();
				else killProcessTree(pid);
			} else if (pid === undefined) {
				child.kill();
			} else {
				try {
					process.kill(-pid, "SIGTERM");
				} catch {}
				setTimeout(() => {
					if (child.exitCode === null) killProcessTree(pid);
				}, 250).unref();
			}
		}
		job.cleanupTimer ??= setTimeout(() => {
			if (!job.terminalized) {
				child?.stdout?.destroy();
				child?.stderr?.destroy();
				this.#terminalize(job, !this.#closed);
			}
		}, 500);
		job.cleanupTimer.unref();
		return snapshot(job);
	}
	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const id of this.#jobs.keys()) this.stop(id);
		for (const job of this.#jobs.values()) this.#terminalize(job, false);
		this.#jobs.clear();
		this.#reminderListeners.clear();
	}
}

export { BgBashJobRegistry as BashJobRegistry };
export type BgBashJobRequest = BashJobRequest;
export type BgBashJobSnapshot = BashJobSnapshot;
export type BgBashJobReminder = BashJobReminder;
