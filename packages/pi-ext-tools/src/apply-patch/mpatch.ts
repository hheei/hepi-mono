import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledMpatchPath } from "./mpatch-binary.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface MpatchRunOptions {
	readonly cwd: string;
	readonly unifiedDiff: string;
	readonly fuzzFactor: number;
	readonly dryRun: boolean;
	readonly signal?: AbortSignal;
}

export interface MpatchRunResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function outputLimitError(): Error {
	return new Error(`mpatch output exceeded ${MAX_OUTPUT_BYTES} bytes`);
}

/** Runs the package-owned mpatch executable against an isolated target directory. */
export async function runMpatch(options: MpatchRunOptions): Promise<MpatchRunResult> {
	if (!Number.isFinite(options.fuzzFactor) || options.fuzzFactor < 0 || options.fuzzFactor > 1)
		throw new Error(`Invalid mpatch fuzz factor: ${options.fuzzFactor}`);
	options.signal?.throwIfAborted();
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "hepi-mpatch-"));
	const patchPath = join(temporaryDirectory, "patch.diff");
	try {
		await writeFile(patchPath, options.unifiedDiff, { encoding: "utf8", signal: options.signal });
		options.signal?.throwIfAborted();
		const args = [
			...(options.dryRun ? ["--dry-run"] : []),
			"--fuzz-factor",
			String(options.fuzzFactor),
			patchPath,
			options.cwd,
		];
		return await new Promise<MpatchRunResult>((resolve, reject) => {
			const child = spawn(getBundledMpatchPath(), args, {
				cwd: options.cwd,
				env: { ...process.env, RAYON_NUM_THREADS: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let outputBytes = 0;
			let settled = false;

			const cleanup = (): void => options.signal?.removeEventListener("abort", abort);
			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				cleanup();
				callback();
			};
			const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
				outputBytes += chunk.byteLength;
				if (outputBytes > MAX_OUTPUT_BYTES) {
					child.kill();
					finish(() => reject(outputLimitError()));
					return;
				}
				if (target === "stdout") stdout += chunk.toString("utf8");
				else stderr += chunk.toString("utf8");
			};
			const abort = (): void => {
				child.kill();
				finish(() => reject(options.signal?.reason ?? new Error("mpatch aborted")));
			};

			child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
			child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
			child.on("error", (error) => finish(() => reject(error)));
			child.on("close", (status) => finish(() => resolve({ status, stdout, stderr })));
			options.signal?.addEventListener("abort", abort, { once: true });
		});
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}
