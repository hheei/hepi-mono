export type StreamingPatchActionType = "add" | "delete" | "update";
const STREAMING_PREVIEW_INPUT_LIMIT = 256 * 1024;

export interface StreamingPatchPreviewAction {
	type: StreamingPatchActionType;
	path: string;
	movePath?: string | undefined;
	added: number;
	removed: number;
}

export interface StreamingPatchPreviewState {
	input: string;
	lineBuffer: string;
	inPatch: boolean;
	truncated: boolean;
	currentAction?: StreamingPatchPreviewAction | undefined;
	actions: StreamingPatchPreviewAction[];
}

export function createStreamingPatchPreviewState(): StreamingPatchPreviewState {
	return {
		input: "",
		lineBuffer: "",
		inPatch: false,
		truncated: false,
		actions: [],
	};
}

function parseActionHeader(line: string):
	| {
			type: StreamingPatchActionType;
			path: string;
	  }
	| undefined {
	const headers = [
		["*** Add File: ", "add"],
		["*** Delete File: ", "delete"],
		["*** Update File: ", "update"],
	] as const satisfies ReadonlyArray<readonly [string, StreamingPatchActionType]>;
	for (const [prefix, type] of headers) {
		if (!line.startsWith(prefix)) continue;
		const path = line.slice(prefix.length).trim();
		return path.length > 0 ? { type, path } : undefined;
	}
	return undefined;
}

function processPreviewLine(state: StreamingPatchPreviewState, line: string): void {
	if (
		!state.inPatch &&
		state.actions.length === 0 &&
		line.trimStart().startsWith("*** Begin Patch")
	) {
		state.inPatch = true;
		state.currentAction = undefined;
		return;
	}
	if (!state.inPatch) return;
	if (line === "*** End Patch") {
		state.inPatch = false;
		state.currentAction = undefined;
		return;
	}

	const actionHeader = parseActionHeader(line);
	if (actionHeader !== undefined) {
		const action: StreamingPatchPreviewAction = {
			...actionHeader,
			added: 0,
			removed: 0,
		};
		state.actions.push(action);
		state.currentAction = action;
		return;
	}

	const action = state.currentAction;
	if (action === undefined) return;
	if (line.startsWith("*** Move to: ") && action.type === "update") {
		const movePath = line.slice("*** Move to: ".length).trim();
		if (movePath.length > 0) action.movePath = movePath;
		return;
	}
	if (action.type === "delete") return;
	if (line.startsWith("+")) {
		action.added += 1;
	} else if (action.type === "update" && line.startsWith("-")) {
		action.removed += 1;
	}
}

function resetStreamingPatchPreviewState(state: StreamingPatchPreviewState): void {
	state.input = "";
	state.lineBuffer = "";
	state.inPatch = false;
	state.truncated = false;
	state.currentAction = undefined;
	state.actions.length = 0;
}

export function updateStreamingPatchPreview(
	state: StreamingPatchPreviewState,
	input: string,
): readonly StreamingPatchPreviewAction[] {
	if (input.length > STREAMING_PREVIEW_INPUT_LIMIT) {
		state.truncated = true;
		state.actions.length = 0;
		return state.actions;
	}
	if (state.truncated) resetStreamingPatchPreviewState(state);
	if (!input.startsWith(state.input)) resetStreamingPatchPreviewState(state);
	const appended = input.slice(state.input.length);
	state.input = input;
	state.lineBuffer += appended;

	let lineStart = 0;
	let lineEnd = state.lineBuffer.indexOf("\n", lineStart);
	while (lineEnd !== -1) {
		const line = state.lineBuffer.slice(lineStart, lineEnd).replace(/\r$/, "");
		processPreviewLine(state, line);
		lineStart = lineEnd + 1;
		lineEnd = state.lineBuffer.indexOf("\n", lineStart);
	}
	state.lineBuffer = state.lineBuffer.slice(lineStart);
	return state.actions;
}
