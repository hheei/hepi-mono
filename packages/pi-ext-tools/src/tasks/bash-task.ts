import type { BashJobRegistry, BashJobSnapshot } from "../bash-jobs.js";
import type {
	AsyncTaskProgress,
	AsyncTaskRegistry,
	AsyncTaskSnapshot,
	AsyncTaskTerminal,
} from "./registry.js";

const MAX_PURPOSE_CHARS = 200;

export interface BashTaskRequest {
	readonly tasks: AsyncTaskRegistry;
	readonly jobs: BashJobRegistry;
	readonly command: string;
	readonly cwd: string;
	readonly shellPath: string;
	readonly timeoutMs?: number;
}

/** One-line intent shown in task listings and terminal deliveries. */
export function bashTaskPurpose(command: string): string {
	const line =
		command
			.split("\n")
			.find((candidate) => candidate.trim() !== "")
			?.trim() ?? "";
	if (line === "") return "background command";
	return line.length > MAX_PURPOSE_CHARS ? `${line.slice(0, MAX_PURPOSE_CHARS)}…` : line;
}

function terminalFrom(job: BashJobSnapshot): AsyncTaskTerminal {
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

/** Starts one background Bash job and registers it as an observable task. */
export function startBashTask(request: BashTaskRequest): AsyncTaskSnapshot {
	return request.tasks.create({
		type: "bash",
		purpose: bashTaskPurpose(request.command),
		begin: (taskId) => {
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
				describe: (): AsyncTaskProgress => {
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
