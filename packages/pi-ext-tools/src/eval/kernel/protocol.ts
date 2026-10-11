export type EvalLanguage = "python";

/** NDJSON line cap, including a 1 MiB eval source plus framing. */
export const MAX_EVAL_FRAME_CHARS = 1_048_576 + 65_536;

export type EvalToolErrorPayload = {
	readonly name: string;
	readonly message: string;
	readonly trace?: unknown;
};

/**
 * The kernel's namespace report for one finished cell, and the model's only direct evidence
 * that names survived. `names` is the current top-level name count; `added` lists names this
 * cell bound for the first time and `redundant` the names it imported again (`addedCount`
 * and `redundantCount` carry the true totals when the lists are capped).
 */
export type EvalKernelState = {
	readonly names: number;
	readonly addedCount: number;
	readonly added: readonly string[];
	readonly redundantCount: number;
	readonly redundant: readonly string[];
};

export type HostToChildMessage =
	| { readonly type: "execute"; readonly cellId: string; readonly code: string }
	| {
			readonly type: "toolResult";
			readonly id: string;
			readonly ok: true;
			readonly value: unknown;
	  }
	| {
			readonly type: "toolResult";
			readonly id: string;
			readonly ok: false;
			readonly error: EvalToolErrorPayload;
	  }
	| { readonly type: "cancel"; readonly cellId: string }
	| { readonly type: "shutdown" };

export type ChildToHostMessage =
	| { readonly type: "ready" }
	| { readonly type: "text"; readonly cellId: string; readonly text: string }
	| { readonly type: "display"; readonly cellId: string; readonly value: unknown }
	/** Output with no cell of its own: a detached task, thread, or raw fd write between cells. */
	| { readonly type: "background"; readonly text: string }
	| {
			readonly type: "toolCall";
			readonly cellId: string;
			readonly id: string;
			readonly name: string;
			readonly args: unknown;
	  }
	| {
			readonly type: "done";
			readonly cellId: string;
			readonly ok: true;
			/** Missing means the cell produced no value at all (for example a bare `print`). */
			readonly value?: unknown;
			readonly state?: EvalKernelState;
	  }
	| {
			readonly type: "done";
			readonly cellId: string;
			readonly ok: false;
			readonly error: string;
			readonly state?: EvalKernelState;
	  };

/**
 * A cell that failed, carrying the namespace report the kernel sent with its `done`.
 * The failure is what the model reads first, so the report travels with the error
 * instead of being dropped by the rejection that delivers it.
 */
export class EvalCellError extends Error {
	readonly state: EvalKernelState | undefined;

	constructor(message: string, state: EvalKernelState | undefined) {
		super(message);
		this.name = "EvalCellError";
		this.state = state;
	}
}

/** Reads the namespace report from a failed cell, if the failure carried one. */
export function evalCellState(error: unknown): EvalKernelState | undefined {
	return error instanceof EvalCellError ? error.state : undefined;
}
