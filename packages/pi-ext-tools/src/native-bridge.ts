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

function isNativeModule(value: unknown): value is NativeModule {
	if (value === null || typeof value !== "object") return false;
	return (
		typeof Reflect.get(value, "piNativeBridgeVersion") === "function" &&
		typeof Reflect.get(value, "runMpatch") === "function"
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
