import { NestedCallArgsIndex, ToolExecutionTracker } from "./tracker.js";

/**
 * The mutable state one extension runtime owns: nested-call captures, the session-branch argument
 * index, and the tool background preference. Two Pi runtimes in one process never share it, so a
 * restart, cleanup or settings change in one cannot reach the other.
 */
export class ToolUiRuntime {
	readonly tracker = new ToolExecutionTracker();
	readonly nestedCalls = new NestedCallArgsIndex();
	/** Pi-native per-tool backgrounds are opt-in; the default is the quiet transparent row. */
	backgrounds = false;

	clear(): void {
		this.tracker.clear();
		this.nestedCalls.setSource(undefined);
	}
}
