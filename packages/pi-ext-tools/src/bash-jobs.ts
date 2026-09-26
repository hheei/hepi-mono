import { type ChildProcess, spawn } from "node:child_process";
import { BashOutputSink } from "./bash-output.js";

export const MAX_JOB_OUTPUT = 1024 * 1024;

export interface BashJobRequest {
	readonly command: string;
	readonly cwd: string;
	readonly shellPath?: string;
	readonly timeoutMs?: number;
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
}
function shellDefault(): string {
	return process.platform === "win32"
		? (process.env.ComSpec ?? "cmd.exe")
		: (process.env.SHELL ?? "/bin/sh");
}
function snapshot(job: Job): BashJobSnapshot {
	const { process: _process, outputSink, ...rest } = job;
	const output = outputSink.snapshot();
	return {
		...rest,
		output: output.output,
		truncated: output.truncated,
	};
}

export class BashJobRegistry {
	readonly #jobs = new Map<string, Job>();
	#closed: boolean = false;
	readonly #tailBytes: number | undefined;
	constructor(
		options: {
			readonly tailBytes?: number;
		} = {},
	) {
		this.#tailBytes = options.tailBytes;
	}
	start(request: BashJobRequest): BashJobSnapshot {
		if (this.#closed) throw new Error("Bash job registry is disposed");
		const outputSink = new BashOutputSink({
			...(this.#tailBytes === undefined ? {} : { tailBytes: this.#tailBytes }),
		});
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
			...(request.onTerminal === undefined ? {} : { onTerminal: request.onTerminal }),
		};
		const shellPath = request.shellPath ?? shellDefault();
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
			if (!this.#closed) job.outputSink.push(data);
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (!this.#closed) job.outputSink.push(data);
		});
		child.once("error", () => {
			if (job.status === "running") {
				job.status = "failed";
				job.endedAt = Date.now();
			}
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
		if (!notify) return;
		job.onTerminal?.(snapshot(job));
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
		this.#jobs.clear();
	}
}
export function defaultShellPath(): string {
	return shellDefault();
}
