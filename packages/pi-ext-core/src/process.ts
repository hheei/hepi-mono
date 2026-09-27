import { spawn } from "node:child_process";
import { abortError } from "./errors.js";

export interface CommandOptions {
	readonly cwd?: string | undefined;
	/** Text written to the child's stdin, which is closed afterwards. */
	readonly input?: string | undefined;
	readonly signal?: AbortSignal | undefined;
	/** Kill the child after this many milliseconds; the result reports `timedOut`. */
	readonly timeoutMs?: number | undefined;
	/** Kill the child once stdout exceeds this many bytes; the result reports `stdoutTruncated`. */
	readonly maxStdoutBytes?: number | undefined;
	/** Observes each stdout/stderr chunk as it arrives, in addition to the collected buffers. */
	readonly onData?: ((chunk: Buffer) => void) | undefined;
}

export interface CommandResult {
	/** Exit code, or 1 when the child was killed by a signal. */
	readonly code: number;
	/** Signal that killed the child, `null` when it exited on its own. */
	readonly signal: string | null;
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly timedOut: boolean;
	readonly stdoutTruncated: boolean;
}

/** Quotes one value for a POSIX shell command line. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Runs a one-shot command and collects its output.
 *
 * The promise resolves for every exit code, including a timeout or a stdout cap
 * (`timedOut` / `stdoutTruncated` describe what happened) so callers keep their
 * own error policy. It rejects only when the command cannot start, or when
 * `signal` aborts; an abort kills the child and rejects with the signal's
 * cancellation error.
 */
export async function runCommand(
	command: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<CommandResult> {
	return await new Promise<CommandResult>((resolveResult, reject) => {
		const child = spawn(command, [...args], {
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let timedOut = false;
		let stdoutTruncated = false;
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			callback();
		};
		const abort = (): void => {
			child.kill();
			finish(() => reject(abortError(options.signal?.reason)));
		};
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						child.kill();
					}, options.timeoutMs);
		if (options.signal?.aborted === true) {
			abort();
			return;
		}
		options.signal?.addEventListener("abort", abort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (options.maxStdoutBytes !== undefined && stdoutBytes > options.maxStdoutBytes) {
				stdoutTruncated = true;
				child.kill();
				return;
			}
			stdout.push(chunk);
			options.onData?.(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr.push(chunk);
			options.onData?.(chunk);
		});
		child.once("error", (error) => finish(() => reject(error)));
		child.once("close", (code, signal) =>
			finish(() =>
				resolveResult({
					code: code ?? 1,
					signal,
					stdout: Buffer.concat(stdout),
					stderr: Buffer.concat(stderr),
					timedOut,
					stdoutTruncated,
				}),
			),
		);
		if (options.input !== undefined) {
			// A command that exits before reading stdin makes the write fail; that is not
			// the caller's concern, so the stream error is swallowed here.
			child.stdin?.on("error", () => undefined);
			child.stdin?.end(options.input);
		}
	});
}
