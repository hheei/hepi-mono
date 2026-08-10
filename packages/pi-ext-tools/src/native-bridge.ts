import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MpatchHunkOutcome } from "./apply-patch/outcome.js";

export interface MpatchRunCommandOptions {
	readonly cwd: string;
	readonly unifiedDiff: string;
	readonly fuzzFactor: number;
	readonly dryRun: boolean;
}

export interface MpatchRunOptions extends MpatchRunCommandOptions {
	readonly signal?: AbortSignal;
}

export interface PtySessionOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly rows: number;
	readonly cols: number;
}

export interface PtyReadResult {
	/** Raw bytes preserve UTF-8 sequences split across native reads. */
	readonly output: Uint8Array;
	readonly eof: boolean;
}

export interface PtyExitStatus {
	readonly code: number;
	readonly signal?: string;
}

function isNativeModule(value: unknown): value is NativeModule {
	if (value === null || typeof value !== "object") return false;
	return (
		typeof Reflect.get(value, "piNativeBridgeVersion") === "function" &&
		typeof Reflect.get(value, "MpatchRun") === "function" &&
		typeof Reflect.get(value, "PtySession") === "function"
	);
}

export interface MpatchRunResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly outcomes: readonly MpatchHunkOutcome[];
}

interface NativeModule {
	readonly piNativeBridgeVersion: () => number;
	readonly MpatchRun: NativeMpatchRunConstructor;
	readonly PtySession: NativePtySessionConstructor;
}

interface NativeMpatchRun {
	run(): Promise<MpatchRunResult>;
	abort(): Promise<void>;
}

interface NativeMpatchRunConstructor {
	new (options: MpatchRunCommandOptions): NativeMpatchRun;
}

interface NativePtySession {
	read(): Promise<PtyReadResult>;
	write(data: Uint8Array): void;
	resize(rows: number, cols: number): void;
	close(): void;
	wait(): Promise<PtyExitStatus>;
}

interface NativePtySessionConstructor {
	new (options: PtySessionOptions): NativePtySession;
}

/**
 * Loads the HEPI-owned N-API bridge built from `crates/pi-ext-bridge`.
 * The bridge is a release output (`native/pi-ext-tools-bridge.node`) and is
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

/** One session-owned pseudo-terminal. Output arrives in native read chunks. */
export class PtySession {
	readonly #native: NativePtySession;
	#waitPromise: Promise<PtyExitStatus> | undefined;

	constructor(options: PtySessionOptions) {
		this.#native = new native.PtySession(options);
	}

	read(): Promise<PtyReadResult> {
		return this.#native.read();
	}

	write(data: Uint8Array): void {
		this.#native.write(data);
	}

	resize(rows: number, cols: number): void {
		this.#native.resize(rows, cols);
	}

	close(): void {
		this.#native.close();
	}

	wait(): Promise<PtyExitStatus> {
		this.#waitPromise ??= this.#native.wait();
		return this.#waitPromise;
	}
}

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
