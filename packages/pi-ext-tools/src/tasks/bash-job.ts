import type { TaskProgress, TaskRegistry, TaskSnapshot, TaskTerminal } from "@hheei/pi-ext-core";
import type { BashJobRegistry, BashJobSnapshot } from "../bash-jobs.js";

const MAX_PURPOSE_CHARS = 200;

export interface BashJobRequest {
	readonly tasks: TaskRegistry;
	readonly jobs: BashJobRegistry;
	readonly command: string;
	readonly cwd: string;
	readonly shellPath: string;
	readonly timeoutMs?: number;
	/** Branch marker captured when the command started. */
	readonly anchor?: string;
}

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
			...(job.timedOut ? { timedOut: true } : {}),
		},
	};
}

/** Starts one background Bash job and registers it as an observable job. */
export function startBashJob(request: BashJobRequest): TaskSnapshot {
	return request.tasks.create({
		type: "bash",
		purpose: bashJobPurpose(request.command),
		...(request.anchor === undefined ? {} : { anchor: request.anchor }),
		begin: (taskId: string) => {
			const job = request.jobs.start({
				command: request.command,
				cwd: request.cwd,
				shellPath: request.shellPath,
				...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
				onTerminal: (finished): void => {
					request.tasks.settle(taskId, terminalFrom(finished));
				},
			});
			return {
				stop: (): void => {
					request.jobs.stop(job.id);
				},
				describe: (): TaskProgress => {
					const current = request.jobs.get(job.id);
					return {
						output: current?.output ?? "",
						truncated: current?.truncated ?? false,
					};
				},
			};
		},
	});
}
