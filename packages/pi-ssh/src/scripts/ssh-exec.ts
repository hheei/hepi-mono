import type { ProcessResult, SessionManager } from "./session-manager.js";
import { MAX_OUTPUT_BYTES, readProcessOutputTail } from "./stream-output.js";

export { MAX_OUTPUT_BYTES };

export interface SshExecArgs {
	host: string;
	command: string;
	timeout?: number;
}

export interface SshExecResult {
	host: string;
	exitCode: number | null;
	output?: string;
	stdout: string;
	stderr: string;
	durationMs: number;
	truncated: boolean;
	totalBytes?: number;
	outputBytes?: number;
	totalLines?: number;
	outputLines?: number;
	notice?: string;
}

export interface ExecuteSshExecOptions {
	timeoutMode?: "throw" | "result";
}

export function validateSshExecArgs(value: unknown): SshExecArgs {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("ssh_exec arguments must be an object");
	}

	const record = value as Record<string, unknown>;
	if (typeof record.host !== "string" || record.host.trim() === "") {
		throw new Error("ssh_exec.host must be a non-empty string");
	}

	const command = record.command ?? record.cmd;
	if (typeof command !== "string" || command.trim() === "") {
		throw new Error("ssh_exec.command must be a non-empty string");
	}

	if (
		record.timeout !== undefined &&
		(typeof record.timeout !== "number" || !Number.isFinite(record.timeout))
	) {
		throw new Error("ssh_exec.timeout must be a finite number");
	}

	return {
		host: validateHost(record.host),
		command,
		timeout: record.timeout as number | undefined,
	};
}

export async function executeSshExec(
	manager: SessionManager,
	args: SshExecArgs,
	options: ExecuteSshExecOptions = {},
): Promise<SshExecResult> {
	const startedAt = Date.now();
	const host = validateHost(args.host);
	const timeoutMs = clampTimeoutSeconds(args.timeout) * 1000;
	const deadlineMs = startedAt + timeoutMs;
	const session = manager.get(host);

	const runner = (sshArgs: string[], timeoutOverrideMs?: number) =>
		runSshProcess(
			manager.sshBin,
			sshArgs,
			remainingTimeoutMs(deadlineMs, timeoutOverrideMs ?? timeoutMs),
			{
				timeoutMode: options.timeoutMode ?? "throw",
				sensitiveValues: manager.sensitiveValues(host),
			},
		);

	await manager.ensureConnected(host, runner);
	const result = await runner(manager.buildRunArgs(session, args.command));
	session.lastUsed = Date.now();

	return {
		host,
		exitCode: result.exitCode,
		output: manager.sanitize(result.output ?? `${result.stdout}${result.stderr}`),
		stdout: manager.sanitize(result.stdout),
		stderr: manager.sanitize(result.stderr),
		durationMs: Date.now() - startedAt,
		truncated: Boolean(result.truncated || result.stdoutTruncated || result.stderrTruncated),
		totalBytes: result.totalBytes,
		outputBytes: result.outputBytes,
		totalLines: result.totalLines,
		outputLines: result.outputLines,
		notice: result.notice ? manager.sanitize(result.notice) : undefined,
	};
}

export function validateHost(host: string): string {
	const trimmed = host.trim();
	if (!trimmed) {
		throw new Error("ssh_exec.host must be a non-empty string");
	}
	if (trimmed.startsWith("-")) {
		throw new Error("ssh_exec.host must not start with '-'");
	}
	if (/[\0\r\n\t ]/.test(trimmed)) {
		throw new Error("ssh_exec.host must not contain whitespace or control characters");
	}
	return trimmed;
}

export function clampTimeoutSeconds(value: number | undefined): number {
	const raw = value ?? envTimeoutSeconds();
	return Math.min(3600, Math.max(1, raw));
}

function envTimeoutSeconds(): number {
	const value =
		process.env.SSH_EXEC_COMMAND_TIMEOUT_SECONDS ?? process.env.SSH_EXEC_TIMEOUT_SECONDS;
	if (!value?.trim()) return 10;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 10;
}

function remainingTimeoutMs(deadlineMs: number, timeoutMs: number): number {
	return Math.min(timeoutMs, Math.max(1, deadlineMs - Date.now()));
}

async function runSshProcess(
	sshBin: string,
	args: string[],
	timeoutMs: number,
	options: ExecuteSshExecOptions & { sensitiveValues?: string[] } = {},
): Promise<ProcessResult> {
	return await managerLikeSpawn(sshBin, args, timeoutMs, options);
}

async function managerLikeSpawn(
	sshBin: string,
	args: string[],
	timeoutMs: number,
	options: ExecuteSshExecOptions & { sensitiveValues?: string[] },
): Promise<ProcessResult> {
	const { spawn } = await import("node:child_process");

	const child = spawn(sshBin, args, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let timedOut = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
		killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
	}, timeoutMs);

	try {
		const [output, exitCode] = await Promise.all([
			readProcessOutputTail(child.stdout, child.stderr, options.sensitiveValues ?? []),
			new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => resolve(code));
			}),
		]);

		if (timedOut) {
			const notice = `SSH command timed out after ${Math.round(timeoutMs / 1000)}s`;
			if (options.timeoutMode === "result") {
				return {
					exitCode: null,
					output: output.text,
					stdout: output.stdout,
					stderr: output.stderr,
					truncated: output.truncated,
					totalBytes: output.totalBytes,
					outputBytes: output.outputBytes,
					totalLines: output.totalLines,
					outputLines: output.outputLines,
					notice,
				};
			}
			throw new Error(notice);
		}

		return {
			exitCode,
			output: output.text,
			stdout: output.stdout,
			stderr: output.stderr,
			truncated: output.truncated,
			totalBytes: output.totalBytes,
			outputBytes: output.outputBytes,
			totalLines: output.totalLines,
			outputLines: output.outputLines,
		};
	} finally {
		clearTimeout(timeout);
		if (killTimer) clearTimeout(killTimer);
	}
}
