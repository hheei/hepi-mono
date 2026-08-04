import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ArtifactRegistry } from "@hheei/pi-ext-core";

interface ArtifactAppendHandle {
	append(data: Uint8Array): void;
	finalize(): `artifact://${number}`;
}

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
	output: string;
	truncated: boolean;
	timedOut: boolean;
	process?: ChildProcess;
	chunks: Buffer[];
	artifactHandle?: ArtifactAppendHandle;
	outputArtifact?: string;
	bytes: number;
	timeout?: NodeJS.Timeout;
}
function shellDefault(): string {
	return process.platform === "win32"
		? (process.env.ComSpec ?? "cmd.exe")
		: (process.env.SHELL ?? "/bin/sh");
}
function append(job: Job, data: Buffer): void {
	job.bytes += data.byteLength;
	job.chunks.push(data);
	const total = job.chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
	if (total > MAX_JOB_OUTPUT) {
		job.truncated = true;
		let drop = total - MAX_JOB_OUTPUT;
		while (drop > 0 && job.chunks.length) {
			const first = job.chunks[0];
			if (!first) break;
			if (first.byteLength <= drop) {
				job.chunks.shift();
				drop -= first.byteLength;
			} else {
				job.chunks[0] = first.subarray(drop);
				drop = 0;
			}
		}
	}
}
function snapshot(job: Job): BashJobSnapshot {
	const {
		process: _process,
		chunks,
		artifactHandle: _artifactHandle,
		bytes: _bytes,
		...rest
	} = job;
	return { ...rest, output: Buffer.concat(chunks).toString("utf8") };
}

export class BashJobRegistry {
	readonly #jobs = new Map<string, Job>();
	#closed: boolean = false;
	readonly #artifacts: ArtifactRegistry | undefined;
	readonly #pi: ExtensionAPI | undefined;
	constructor(options: { readonly artifacts?: ArtifactRegistry; readonly pi?: ExtensionAPI } = {}) {
		this.#artifacts = options.artifacts;
		this.#pi = options.pi;
	}
	start(
		command: string,
		cwd: string,
		shellPath = shellDefault(),
		timeoutMs?: number,
	): BashJobSnapshot {
		if (this.#closed) throw new Error("Bash job registry is disposed");
		const id = `job-${crypto.randomUUID()}`;
		const artifactHandle = this.#artifacts?.createAppend();
		const job: Job = {
			id,
			command,
			cwd,
			status: "running",
			exitCode: null,
			startedAt: Date.now(),
			output: "",
			truncated: false,
			timedOut: false,
			chunks: [],
			...(artifactHandle === undefined ? {} : { artifactHandle }),
			bytes: 0,
		};
		const child = spawn(
			shellPath,
			process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command],
			{ cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
		);
		job.process = child;
		child.stdout?.on("data", (data: Buffer) => {
			if (!this.#closed) job.artifactHandle?.append(data);
			append(job, data);
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (!this.#closed) job.artifactHandle?.append(data);
			append(job, data);
		});
		child.once("error", () => {
			if (job.status === "running") {
				job.status = "failed";
				job.endedAt = Date.now();
			}
		});
		child.once("close", (code, signal) => {
			clearTimeout(job.timeout);
			if (job.status !== "running") return;
			if (this.#closed) return;
			job.exitCode = code;
			job.status = signal ? "stopped" : code === 0 ? "completed" : "failed";
			job.endedAt = Date.now();
			if (job.artifactHandle) job.outputArtifact = job.artifactHandle.finalize();
			const tail = snapshot(job).output.slice(-MAX_COMPLETION_TAIL);
			if (this.#pi)
				this.#pi.sendMessage(
					{
						customType: "bash-job-complete",
						content: `Bash job ${job.id} ${job.status}\n${tail}`,
						display: true,
						details: { jobId: job.id, status: job.status, tail, output: job.outputArtifact },
					},
					{ triggerTurn: false },
				);
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
