import { runMpatch as runNativeMpatch } from "../native-bridge.js";

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

/** Runs vendored mpatch against an isolated staging directory. */
export async function runMpatch(options: MpatchRunOptions): Promise<MpatchRunResult> {
	if (!Number.isFinite(options.fuzzFactor) || options.fuzzFactor < 0 || options.fuzzFactor > 1)
		throw new Error(`Invalid mpatch fuzz factor: ${options.fuzzFactor}`);
	options.signal?.throwIfAborted();
	try {
		return await runNativeMpatch({
			cwd: options.cwd,
			unifiedDiff: options.unifiedDiff,
			fuzzFactor: options.fuzzFactor,
			dryRun: options.dryRun,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		throw error;
	}
}
