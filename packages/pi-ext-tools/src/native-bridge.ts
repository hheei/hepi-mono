import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MpatchRunCommandOptions {
	readonly cwd: string;
	readonly unifiedDiff: string;
	readonly fuzzFactor: number;
	readonly dryRun: boolean;
}

export interface MpatchRunOptions extends MpatchRunCommandOptions {
	readonly signal?: AbortSignal;
}

function isNativeModule(value: unknown): value is NativeModule {
	if (value === null || typeof value !== "object") return false;
	return (
		typeof Reflect.get(value, "piNativeBridgeVersion") === "function" &&
		typeof Reflect.get(value, "MpatchRun") === "function"
	);
}

export interface MpatchRunResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

interface NativeModule {
	readonly piNativeBridgeVersion: () => number;
	readonly MpatchRun: NativeMpatchRunConstructor;
}

interface NativeMpatchRun {
	run(): Promise<MpatchRunResult>;
	abort(): Promise<void>;
}

interface NativeMpatchRunConstructor {
	new (options: MpatchRunCommandOptions): NativeMpatchRun;
}

/**
 * Loads the HEPI-owned N-API bridge built from `crates/pi-ext-bridge`.
 * The bridge is a release artifact (`native/pi-ext-tools-bridge.node`) and is
 * not committed; callers must tolerate its absence unless they require native
 * execution.
 */
function loadNative(): NativeModule {
	const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	const nativePath = join(packageRoot, "native", "pi-ext-tools-bridge.node");
	if (!existsSync(nativePath)) {
		throw new Error(`Native bridge is not built: ${nativePath}`);
	}
	const require = createRequire(import.meta.url);
	const loaded: unknown = require(nativePath);
	if (!isNativeModule(loaded)) throw new Error(`Invalid native bridge: ${nativePath}`);
	return loaded;
}

const native = loadNative();

export const piNativeBridgeVersion: number = native.piNativeBridgeVersion();

/** One cancellable, single-use vendored mpatch invocation. */
export class MpatchRun {
	readonly #native: NativeMpatchRun;

	constructor(options: MpatchRunCommandOptions) {
		this.#native = new native.MpatchRun(options);
	}

	run(): Promise<MpatchRunResult> {
		return this.#native.run();
	}

	abort(): Promise<void> {
		return this.#native.abort();
	}
}

/** Maps a JavaScript AbortSignal to one cooperative native mpatch run. */
export async function runMpatch(options: MpatchRunOptions): Promise<MpatchRunResult> {
	options.signal?.throwIfAborted();
	const run = new MpatchRun({
		cwd: options.cwd,
		unifiedDiff: options.unifiedDiff,
		fuzzFactor: options.fuzzFactor,
		dryRun: options.dryRun,
	});
	let abortPromise: Promise<void> | undefined;
	const abort = (): void => {
		abortPromise ??= run.abort();
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		const result = await run.run();
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("mpatch aborted");
		return result;
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", abort);
		if (abortPromise !== undefined) await abortPromise;
	}
}
