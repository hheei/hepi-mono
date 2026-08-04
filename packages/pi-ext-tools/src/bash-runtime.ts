import { access, constants } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { DisposerRegistry } from "@hheei/pi-ext-core";

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface BrushShell {
	run(
		options: {
			readonly command: string;
			readonly cwd: string;
			readonly env: Readonly<Record<string, string>>;
			readonly timeoutMs?: number;
			readonly signal?: AbortSignal;
		},
		onChunk: (chunk: string) => void,
	): Promise<{
		readonly exitCode?: number;
		readonly cancelled: boolean;
		readonly timedOut: boolean;
	}>;
	abort(): Promise<void>;
}

export interface BashRuntimeState {
	getShell(): BrushShell | undefined;
}

interface MutableBashRuntimeState {
	shell: BrushShell | undefined;
}

const runtimeStates = new WeakMap<BashRuntimeState, MutableBashRuntimeState>();

/** Creates the session-owned Brush handle view consumed by the static bash tool. */
export function createBashRuntimeState(): BashRuntimeState {
	const state: BashRuntimeState = {
		getShell: (): BrushShell | undefined => runtimeStates.get(state)?.shell,
	};
	runtimeStates.set(state, { shell: undefined });
	return state;
}

/** Loads native code only after Pi creates a session, then aborts it on teardown. */
export async function startBashRuntime(
	state: BashRuntimeState,
	resources: DisposerRegistry,
): Promise<void> {
	const mutable = runtimeStates.get(state);
	if (mutable === undefined)
		throw new Error("Bash runtime state must be created by createBashRuntimeState()");
	const { Shell } = await import("./native-bridge.js");
	const shell = new Shell();
	mutable.shell = shell;
	resources.add("brush-shell", async () => {
		if (mutable.shell === shell) mutable.shell = undefined;
		await shell.abort();
	});
}

function nativeEnvironment(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env ?? {})) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

function timeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new Error("Invalid timeout: must be a finite number of seconds");
	const result = timeout * 1000;
	if (result > MAX_TIMEOUT_MS)
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	return result;
}

/** Adapts Pi's BashOperations contract to one session-scoped native Brush shell. */
export function createBrushBashOperations(getShell: () => BrushShell | undefined): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			if (options.signal?.aborted) throw new Error("aborted");
			try {
				await access(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}
			const shell = getShell();
			if (shell === undefined) throw new Error("Native Bash session is unavailable");
			const nativeTimeoutMs = timeoutMs(options.timeout);
			const result = await shell.run(
				{
					command,
					cwd,
					env: nativeEnvironment(options.env),
					...(nativeTimeoutMs === undefined ? {} : { timeoutMs: nativeTimeoutMs }),
					...(options.signal === undefined ? {} : { signal: options.signal }),
				},
				(chunk) => options.onData(Buffer.from(chunk)),
			);
			if (result.cancelled) throw new Error("aborted");
			if (result.timedOut) throw new Error(`timeout:${options.timeout}`);
			return { exitCode: result.exitCode ?? null };
		},
	};
}
