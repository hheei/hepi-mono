import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MpatchRunCommandOptions {
	readonly executablePath: string;
	readonly cwd: string;
	readonly unifiedDiff: string;
	readonly fuzzFactor: number;
	readonly dryRun: boolean;
}

export interface MpatchRunOptions extends MpatchRunCommandOptions {
	readonly signal?: AbortSignal;
}

export interface ShellOptions {
	readonly sessionEnv?: Readonly<Record<string, string>>;
	readonly snapshotPath?: string;
}

export interface ShellRunOptions {
	readonly command: string;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface ShellRunResult {
	readonly exitCode?: number;
	readonly cancelled: boolean;
	readonly timedOut: boolean;
	readonly workingDir?: string;
}

export type ShellChunkHandler = (chunk: string) => void;

function isNativeModule(value: unknown): value is NativeModule {
	if (value === null || typeof value !== "object") return false;
	return (
		typeof Reflect.get(value, "piNativeBridgeVersion") === "function" &&
		typeof Reflect.get(value, "MpatchRun") === "function" &&
		typeof Reflect.get(value, "Shell") === "function"
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
	readonly Shell: NativeShellConstructor;
}

interface NativeMpatchRun {
	run(): Promise<MpatchRunResult>;
	abort(): Promise<void>;
}

interface NativeMpatchRunConstructor {
	new (options: MpatchRunCommandOptions): NativeMpatchRun;
}

interface NativeShell {
	run(options: ShellRunOptions, onChunk?: NativeShellChunkHandler): Promise<ShellRunResult>;
	abort(): Promise<void>;
	liveBackgroundJobCount(): Promise<number>;
}

type NativeShellChunkHandler = (error: Error | null, chunk: string) => void;

interface NativeShellConstructor {
	new (options?: ShellOptions): NativeShell;
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

/** One cancellable, single-use package-owned mpatch invocation. */
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

/** Maps a JavaScript AbortSignal to a single native mpatch process. */
export async function runMpatch(options: MpatchRunOptions): Promise<MpatchRunResult> {
	options.signal?.throwIfAborted();
	const run = new MpatchRun({
		executablePath: options.executablePath,
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

/**
 * Session-scoped Brush shell backed by vendored, patched uutils builtins.
 * The N-API layer owns AbortSignal conversion and bounds streamed output;
 * callers must abort the shell while disposing their Pi session.
 */
export class Shell {
	readonly #native: NativeShell;

	constructor(options: ShellOptions = {}) {
		this.#native = new native.Shell(options);
	}

	run(options: ShellRunOptions, onChunk?: ShellChunkHandler): Promise<ShellRunResult> {
		if (onChunk === undefined) return this.#native.run(options);
		return this.#native.run(options, (_error, chunk) => onChunk(chunk));
	}

	abort(): Promise<void> {
		return this.#native.abort();
	}

	liveBackgroundJobCount(): Promise<number> {
		return this.#native.liveBackgroundJobCount();
	}
}
