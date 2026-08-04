import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MpatchRunOptions {
	readonly executablePath: string;
	readonly cwd: string;
	readonly unifiedDiff: string;
	readonly fuzzFactor: number;
	readonly dryRun: boolean;
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
		typeof Reflect.get(value, "runMpatch") === "function" &&
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
	readonly runMpatch: (options: {
		readonly executablePath: string;
		readonly cwd: string;
		readonly unifiedDiff: string;
		readonly fuzzFactor: number;
		readonly dryRun: boolean;
	}) => Promise<MpatchRunResult>;
	readonly Shell: NativeShellConstructor;
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

export function runMpatch(options: MpatchRunOptions): Promise<MpatchRunResult> {
	return native.runMpatch(options);
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
