import { type ChildProcess, spawn } from "node:child_process";
import { BashOutputSink } from "./bash-output.js";

export const MAX_JOB_OUTPUT = 1024 * 1024;

export interface BashJobRequest {
	readonly command: string;
	readonly cwd: string;
	readonly shellPath?: string;
	readonly timeoutMs?: number;
	/** Optional real-time stream callback receiving raw output chunks. */
	readonly onData?: (data: Buffer) => void;
	/** Called once when the job reaches a terminal state and the registry is still open. */
	readonly onTerminal?: (job: BashJobSnapshot) => void;
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
	/** True only when this registry stopped the job after its requested timeout. */
	readonly timedOut: boolean;
}

interface Job {
	id: string;
	command: string;
	cwd: string;
	status: BashJobSnapshot["status"];
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	timedOut: boolean;
	process?: ChildProcess;
	outputSink: BashOutputSink;
	timeout?: NodeJS.Timeout;
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
		...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
		output: output.output,
		truncated: output.truncated,
	};
}

export class BashJobRegistry {
	readonly #jobs = new Map<string, Job>();
	#closed: boolean = false;
	readonly #tailBytes: number | undefined;
	constructor(tailBytes?: number) {
		this.#tailBytes = tailBytes;
	}
	start(request: BashJobRequest): BashJobSnapshot {
		if (this.#closed) throw new Error("Bash job registry is disposed");
		const outputSink = new BashOutputSink(this.#tailBytes);
		const id = crypto.randomUUID();
		const job: Job = {
			id,
			command: request.command,
			cwd: request.cwd,
			status: "running",
			exitCode: null,
			startedAt: Date.now(),
			timedOut: false,
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
				request.onData?.(data);
			}
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (!this.#closed) {
				job.outputSink.push(data);
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
				job.endedAt = Date.now();
			}
			// `close` usually follows a spawn failure, but a post-spawn error may not report one.
			this.#terminalize(job, !this.#closed);
		});
		child.once("close", (code, signal) => {
			clearTimeout(job.timeout);
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
		return snapshot(job);
	}
	#terminalize(job: Job, notify: boolean): void {
		if (job.terminalized) return;
		job.terminalized = true;
		job.outputSink.finish();
		const finalSnapshot = snapshot(job);
		const waiter = job.waiter;
		job.waiter = undefined;
		waiter?.(finalSnapshot);
		if (!notify) return;
		job.onTerminal?.(finalSnapshot);
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
		job.status = "stopped";
		job.endedAt = Date.now();
		const child = job.process;
		clearTimeout(job.timeout);
		if (child && !child.killed) {
			if (process.platform !== "win32" && child.pid)
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {}
			else child.kill();
			setTimeout(() => {
				if (child.exitCode === null) {
					try {
						if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				}
			}, 250).unref();
		}
		return snapshot(job);
	}
	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const id of this.#jobs.keys()) this.stop(id);
		for (const job of this.#jobs.values()) this.#terminalize(job, false);
		this.#jobs.clear();
	}
}
