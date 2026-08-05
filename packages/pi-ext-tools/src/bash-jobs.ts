import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ArtifactRegistry } from "@hheei/pi-ext-core";
import { BashOutputSink } from "./bash-output.js";

export const MAX_JOB_OUTPUT = 1024 * 1024;
const MAX_COMPLETION_TAIL = 10_000;
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
	readonly outputArtifact?: string;
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
	outputArtifact?: string;
	timeout?: NodeJS.Timeout;
	terminalized: boolean;
}
function shellDefault(): string {
	return process.platform === "win32"
		? (process.env.ComSpec ?? "cmd.exe")
		: (process.env.SHELL ?? "/bin/sh");
}
function snapshot(job: Job): BashJobSnapshot {
	const { process: _process, outputSink, outputArtifact: _outputArtifact, ...rest } = job;
	const output = outputSink.snapshot();
	return {
		...rest,
		output: output.output,
		truncated: output.truncated,
		...(output.artifactUri === undefined ? {} : { outputArtifact: output.artifactUri }),
	};
}

export class BashJobRegistry {
	readonly #jobs = new Map<string, Job>();
	#closed: boolean = false;
	readonly #artifacts: ArtifactRegistry | undefined;
	readonly #pi: ExtensionAPI | undefined;
	readonly #tailBytes: number | undefined;
	constructor(
		options: {
			readonly artifacts?: ArtifactRegistry;
			readonly pi?: ExtensionAPI;
			readonly tailBytes?: number;
		} = {},
	) {
		this.#artifacts = options.artifacts;
		this.#pi = options.pi;
		this.#tailBytes = options.tailBytes;
	}
	start(
		command: string,
		cwd: string,
		shellPath = shellDefault(),
		timeoutMs?: number,
	): BashJobSnapshot {
		if (this.#closed) throw new Error("Bash job registry is disposed");
		const outputSink = new BashOutputSink({
			...(this.#artifacts === undefined ? {} : { artifacts: this.#artifacts }),
			...(this.#tailBytes === undefined ? {} : { tailBytes: this.#tailBytes }),
			reserveArtifact: true,
		});
		const artifactUri = outputSink.artifactUri;
		const id = artifactUri?.slice("artifact://".length) ?? crypto.randomUUID();
		const job: Job = {
			id,
			command,
			cwd,
			status: "running",
			exitCode: null,
			startedAt: Date.now(),
			timedOut: false,
			outputSink,
			terminalized: false,
		};
		const child = spawn(
			shellPath,
			process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command],
			{ cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
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
		if (timeoutMs !== undefined && timeoutMs > 0) {
			job.timeout = setTimeout(() => {
				job.timedOut = true;
				this.stop(id);
			}, timeoutMs);
		}
		this.#jobs.set(id, job);
		return snapshot(job);
	}
	#terminalize(job: Job, notify: boolean): void {
		if (job.terminalized) return;
		job.terminalized = true;
		const output = job.outputSink.finish();
		if (output.artifactUri !== undefined) job.outputArtifact = output.artifactUri;
		if (!notify || this.#pi === undefined) return;
		const tail = output.output.slice(-MAX_COMPLETION_TAIL);
		this.#pi.sendMessage(
			{
				customType: "bash-job-complete",
				content: `Bash job ${job.id} ${job.status}\n${tail}`,
				display: true,
				details: { jobId: job.id, status: job.status, tail, output: job.outputArtifact },
			},
			{ triggerTurn: false },
		);
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
