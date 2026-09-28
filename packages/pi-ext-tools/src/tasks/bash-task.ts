import type { TaskProgress, TaskRegistry, TaskSnapshot, TaskTerminal } from "@hheei/pi-ext-core";
import type { BashJobRegistry, BashJobSnapshot } from "../bash-jobs.js";

const MAX_PURPOSE_CHARS = 200;

export interface BashTaskRequest {
	readonly tasks: TaskRegistry;
	readonly jobs: BashJobRegistry;
	readonly command: string;
	readonly cwd: string;
	readonly shellPath: string;
	readonly timeoutMs?: number;
	/** Branch marker captured when the command started. */
	readonly anchor?: string;
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

/** Starts one background Bash job and registers it as an observable task. */
export function startBashTask(request: BashTaskRequest): TaskSnapshot {
	return request.tasks.create({
		type: "bash",
		purpose: bashTaskPurpose(request.command),
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

export interface PromoteBashTaskRequest {
	readonly tasks: TaskRegistry;
	readonly jobs: BashJobRegistry;
	readonly jobId: string;
	readonly command: string;
	/** Branch marker captured when the command started. */
	readonly anchor?: string;
}

/** Promotes an already running Bash job into an observable task. */
export function promoteBashJobToTask(request: PromoteBashTaskRequest): TaskSnapshot | undefined {
	const current = request.jobs.get(request.jobId);
	if (current === undefined || current.status !== "running") return undefined;
	return request.tasks.create({
		type: "bash",
		purpose: bashTaskPurpose(request.command),
		...(request.anchor === undefined ? {} : { anchor: request.anchor }),
		begin: (taskId: string) => {
			request.jobs.bindTerminal(request.jobId, (finished): void => {
				request.tasks.settle(taskId, terminalFrom(finished));
			});
			return {
				stop: (): void => {
					request.jobs.stop(request.jobId);
				},
				describe: (): TaskProgress => {
					const job = request.jobs.get(request.jobId);
					return {
						output: job?.output ?? "",
						truncated: job?.truncated ?? false,
					};
				},
			};
		},
	});
}
