import type { EvalKernelState } from "./kernel/protocol.js";

/** Hooks the eval tool supplies for one cell; the kernel host owns when each one runs. */
export interface EvalRuntimeHooks {
	readonly cwd: string;
	onText(text: string): void;
	onDisplay(value: unknown): void;
	/** Output the kernel could not attribute to a cell: a detached task, thread, or raw fd write. */
	onBackground(text: string): void;
	callTool(name: string, args: unknown): Promise<unknown>;
}

/** What one cell produced, plus what the host knows about the kernel that ran it. */
export interface EvalRunResult {
	readonly value: unknown;
	/** The kernel's namespace report, when the cell reached its `done` message. */
	readonly state: EvalKernelState | undefined;
	/** The kernel is not the one the previous cell used, so its names are gone. */
	readonly restarted: boolean;
	/** A prior cell had no terminal fact when this runtime was recreated. */
	readonly recovered?: string;
}
