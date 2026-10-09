/**
 * Display-only recognition of V4A operation headers in a patch that is still
 * streaming. Mirrors the recognition rules pi-ext-tools' parser applies, but
 * only as far as drawing `󰄰 create|modify|delete path +A -D` preview rows
 * requires: a line is a candidate header, a payload line, or stops the preview.
 */
export interface V4aPreviewOperationView {
	readonly kind: "add" | "delete" | "update";
	readonly path: string;
	readonly addedLines: number;
	readonly removedLines: number;
}

/** Opaque cursor stored in the render state across streamed updates. */
export interface V4aPreviewCursor {
	consumed: string;
	operations: MutablePreviewOperation[];
	stopped: boolean;
}

type MutablePreviewOperation = {
	kind: "add" | "delete" | "update";
	path: string;
	addedLines: number;
	removedLines: number;
};

const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const MAX_PREVIEW_OPERATIONS = 128;

function parseHeader(
	text: string,
): { kind: "add" | "delete" | "update"; path: string } | undefined {
	if (text.startsWith(ADD)) return { kind: "add", path: text.slice(ADD.length) };
	if (text.startsWith(DELETE)) return { kind: "delete", path: text.slice(DELETE.length) };
	if (text.startsWith(UPDATE)) return { kind: "update", path: text.slice(UPDATE.length) };
	return undefined;
}

function previewablePath(path: string): boolean {
	return path !== "" && !path.includes("\0") && path !== BEGIN && path !== END;
}

function applyPreviewLine(state: V4aPreviewCursor, text: string): boolean {
	if (text === BEGIN || text === END) return true;
	const header = parseHeader(text);
	if (header !== undefined) {
		if (!previewablePath(header.path) || state.operations.length >= MAX_PREVIEW_OPERATIONS)
			return false;
		state.operations.push({ kind: header.kind, path: header.path, addedLines: 0, removedLines: 0 });
		return true;
	}
	const current = state.operations.at(-1);
	if (current === undefined) return true;
	if (current.kind === "update" && text.startsWith(MOVE)) {
		const moveTo = text.slice(MOVE.length);
		if (!previewablePath(moveTo)) return false;
		current.path = moveTo;
		return true;
	}
	if (current.kind === "add") {
		if (!text.startsWith("+")) return false;
		if (text.slice(1).length > 0) current.addedLines += 1;
		return true;
	}
	if (current.kind === "delete") return false;
	if (text.startsWith("@@") || text.startsWith(" ")) return true;
	if (text.startsWith("+")) {
		current.addedLines += 1;
		return true;
	}
	if (text.startsWith("-")) {
		current.removedLines += 1;
		return true;
	}
	return false;
}

/**
 * Incremental preview of the operation headers completed so far. The cursor
 * lives in the render state so each streamed update only processes new lines.
 */
export function previewV4aOperations(
	input: string,
	argsComplete: boolean,
	cursor: V4aPreviewCursor | undefined,
): readonly V4aPreviewOperationView[] {
	const state: V4aPreviewCursor = cursor ?? { consumed: "", operations: [], stopped: false };
	if (!input.startsWith(state.consumed)) {
		state.consumed = "";
		state.operations = [];
		state.stopped = false;
	}
	if (state.stopped) return state.operations.map((operation) => ({ ...operation }));

	const lines = (input.slice(state.consumed.length).match(/[^\n]*\n?/g) ?? []).filter(
		(line) => line !== "",
	);
	for (const [index, raw] of lines.entries()) {
		const newline = raw.endsWith("\n") ? "\n" : "";
		const text = newline === "" ? raw : raw.slice(0, -1).replace(/\r$/, "");
		const complete = newline !== "" || (argsComplete && index === lines.length - 1);
		if (!complete) break;
		const applied = applyPreviewLine(state, text);
		if (!applied) {
			state.stopped = true;
			break;
		}
		state.consumed += raw;
	}
	return state.operations.map((operation) => ({ ...operation }));
}
