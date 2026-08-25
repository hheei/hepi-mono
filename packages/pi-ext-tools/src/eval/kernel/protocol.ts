export type EvalLanguage = "javascript" | "python";

/** NDJSON line cap, including a 1 MiB eval source plus framing. */
export const MAX_EVAL_FRAME_CHARS = 1_048_576 + 65_536;

export type EvalToolErrorPayload = {
	readonly name: string;
	readonly message: string;
	readonly trace?: unknown;
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
			readonly value: unknown;
	  }
	| {
			readonly type: "done";
			readonly cellId: string;
			readonly ok: false;
			readonly error: string;
	  };
