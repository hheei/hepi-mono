export type V4aPatchOperation = V4aAddOperation | V4aDeleteOperation | V4aUpdateOperation;

export interface V4aAddOperation {
	readonly kind: "add";
	readonly path: string;
	readonly content: string;
}

export interface V4aDeleteOperation {
	readonly kind: "delete";
	readonly path: string;
}

export interface V4aUpdateOperation {
	readonly kind: "update";
	readonly path: string;
	readonly moveTo?: string;
	readonly hunks: readonly V4aUpdateHunk[];
}

export interface V4aUpdateHunk {
	readonly anchor?: string;
	readonly lines: readonly V4aUpdateLine[];
}

export type V4aUpdateLine = V4aContextLine | V4aAddedLine | V4aRemovedLine;

export interface V4aContextLine {
	readonly kind: "context";
	readonly text: string;
}

export interface V4aAddedLine {
	readonly kind: "add";
	readonly text: string;
}

export interface V4aRemovedLine {
	readonly kind: "remove";
	readonly text: string;
}

export interface V4aPatch {
	readonly operations: readonly V4aPatchOperation[];
}

export interface V4aPatchConflict {
	readonly path: string;
	readonly operationIndices: readonly number[];
	readonly message: string;
}

interface SourceLine {
	readonly text: string;
	readonly newline: string;
}

interface ParsedHeader {
	readonly kind: "add" | "delete" | "update";
	readonly path: string;
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";

export function parseV4aPatch(input: string): V4aPatch {
	const lines = normalizeEnvelope(splitLines(input));
	if (lines.length < 2 || lines[0]?.text !== BEGIN)
		throw parseError("missing Begin Patch envelope");

	let index = 1;
	const operations: V4aPatchOperation[] = [];
	let sawEnd = false;

	while (index < lines.length) {
		const current = lines[index];
		if (current === undefined) throw parseError("unexpected end of patch");
		if (current.text === END) {
			sawEnd = true;
			index += 1;
			break;
		}
		const header = parseHeader(current.text);
		if (header === undefined) throw parseError(`unknown patch header: ${current.text}`);
		assertPatchPath(header.path);

		if (header.kind === "add") {
			const result = parseAdd(lines, index + 1, header.path);
			operations.push(result.operation);
			index = result.nextIndex;
			continue;
		}

		if (header.kind === "delete") {
			const nextIndex = index + 1;
			if (nextIndex < lines.length && !isHeaderOrEnd(lines[nextIndex]?.text ?? ""))
				throw parseError("Delete actions cannot contain body lines");
			operations.push(Object.freeze({ kind: "delete", path: header.path }));
			index = nextIndex;
			continue;
		}

		const result = parseUpdate(lines, index + 1, header.path);
		operations.push(result.operation);
		index = result.nextIndex;
	}

	if (!sawEnd) throw parseError("missing End Patch envelope");
	if (index !== lines.length) throw parseError("content after End Patch envelope");
	if (operations.length === 0) throw parseError("patch contains no actions");

	return Object.freeze({ operations: Object.freeze(operations) });
}

export function operationTouchedPaths(operation: V4aPatchOperation): readonly string[] {
	return operation.kind === "update" && operation.moveTo !== undefined
		? [operation.path, operation.moveTo]
		: [operation.path];
}

/** Finds operation graph conflicts without reading or mutating the workspace. */
export function findV4aPatchConflicts(patch: V4aPatch): readonly V4aPatchConflict[] {
	const touched = new Map<
		string,
		{ readonly index: number; readonly operation: V4aPatchOperation }[]
	>();
	for (const [index, operation] of patch.operations.entries()) {
		for (const path of operationTouchedPaths(operation)) {
			const indices = touched.get(path) ?? [];
			indices.push({ index, operation });
			touched.set(path, indices);
		}
	}
	const conflicts: V4aPatchConflict[] = [];
	for (const [path, touches] of touched) {
		const operationIndices = Object.freeze([...new Set(touches.map(({ index }) => index))]);
		const repeatedWithinOperation = touches.length !== operationIndices.length;
		const compatibleReplace =
			operationIndices.length === 2 &&
			touches.every(({ operation }) => operation.kind === "add" || operation.kind === "delete") &&
			new Set(touches.map(({ operation }) => operation.kind)).size === 2;
		if (!repeatedWithinOperation && (operationIndices.length < 2 || compatibleReplace)) continue;
		conflicts.push(
			Object.freeze({
				path,
				operationIndices,
				message: `path touched more than once: ${path}`,
			}),
		);
	}
	return Object.freeze(conflicts);
}

export function compileV4aUpdateToUnifiedDiff(operation: V4aUpdateOperation): string {
	if (operation.hunks.length === 0) throw parseError("update contains no hunks");
	const oldPath = `a/${operation.path}`;
	// Moving remains a deterministic staging operation. mpatch only transforms
	// the source file so unified diff headers cannot turn a fuzzy update into a rename.
	const newPath = `b/${operation.path}`;
	const out: string[] = [`--- ${oldPath}\n`, `+++ ${newPath}\n`];

	for (const hunk of operation.hunks) {
		const oldCount = hunk.lines.filter((line) => line.kind !== "add").length;
		const newCount = hunk.lines.filter((line) => line.kind !== "remove").length;
		const oldStart = oldCount === 0 ? 0 : 1;
		const newStart = newCount === 0 ? 0 : 1;
		out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunk.anchor ?? ""}\n`);
		for (const line of hunk.lines) {
			const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
			out.push(`${prefix}${line.text}`);
		}
	}

	return out.join("");
}

function parseAdd(
	lines: readonly SourceLine[],
	start: number,
	path: string,
): { readonly operation: V4aAddOperation; readonly nextIndex: number } {
	let index = start;
	const content: string[] = [];
	while (index < lines.length) {
		const line = lines[index];
		if (line === undefined) throw parseError("unexpected end of add action");
		if (isHeaderOrEnd(line.text)) break;
		if (!line.text.startsWith("+")) throw parseError("Add content lines must begin with +");
		content.push(line.text.slice(1), line.newline);
		index += 1;
	}
	if (content.length === 0) throw parseError("Add action must contain content");
	return {
		operation: Object.freeze({ kind: "add", path, content: content.join("") }),
		nextIndex: index,
	};
}

function parseUpdate(
	lines: readonly SourceLine[],
	start: number,
	path: string,
): { readonly operation: V4aUpdateOperation; readonly nextIndex: number } {
	let index = start;
	let moveTo: string | undefined;
	if (index < lines.length && lines[index]?.text.startsWith(MOVE)) {
		moveTo = lines[index]?.text.slice(MOVE.length);
		if (moveTo === undefined) throw parseError("empty move target");
		assertPatchPath(moveTo);
		index += 1;
	}

	const hunks: V4aUpdateHunk[] = [];
	let current: { anchor?: string; lines: V4aUpdateLine[] } = { lines: [] };
	let adds = 0;
	let removes = 0;

	while (index < lines.length) {
		const line = lines[index];
		if (line === undefined) throw parseError("unexpected end of update action");
		if (isHeaderOrEnd(line.text)) break;
		if (line.text.startsWith(MOVE))
			throw parseError("Move to must appear immediately after Update File");
		if (line.text.startsWith("@@")) {
			if (current.lines.length > 0) hunks.push(freezeHunk(current));
			current = { anchor: line.text.slice(2), lines: [] };
			index += 1;
			continue;
		}
		const parsedLine = parseUpdateLine(line);
		if (parsedLine.kind === "add") adds += 1;
		if (parsedLine.kind === "remove") removes += 1;
		current.lines.push(parsedLine);
		index += 1;
	}

	if (current.lines.length > 0) hunks.push(freezeHunk(current));
	if (hunks.length === 0) throw parseError("Update action must contain body lines");
	if (adds === 0 && removes === 0) throw parseError("Update action must change content");
	const operation =
		moveTo === undefined
			? freezeUpdate({ kind: "update", path, hunks })
			: freezeUpdate({ kind: "update", path, moveTo, hunks });
	return { operation, nextIndex: index };
}

function parseUpdateLine(line: SourceLine): V4aUpdateLine {
	const marker = line.text[0];
	const text = `${line.text.slice(1)}${line.newline}`;
	if (marker === " ") return Object.freeze({ kind: "context", text });
	if (marker === "+") return Object.freeze({ kind: "add", text });
	if (marker === "-") return Object.freeze({ kind: "remove", text });
	throw parseError("Update body lines must begin with space, +, -, or @@");
}

function freezeHunk(hunk: {
	readonly anchor?: string;
	readonly lines: readonly V4aUpdateLine[];
}): V4aUpdateHunk {
	const lines = Object.freeze([...hunk.lines]);
	return hunk.anchor === undefined
		? Object.freeze({ lines })
		: Object.freeze({ anchor: hunk.anchor, lines });
}

function freezeUpdate(operation: {
	readonly kind: "update";
	readonly path: string;
	readonly moveTo?: string;
	readonly hunks: readonly V4aUpdateHunk[];
}): V4aUpdateOperation {
	const hunks = Object.freeze([...operation.hunks]);
	return operation.moveTo === undefined
		? Object.freeze({ kind: operation.kind, path: operation.path, hunks })
		: Object.freeze({
				kind: operation.kind,
				path: operation.path,
				moveTo: operation.moveTo,
				hunks,
			});
}

function parseHeader(text: string): ParsedHeader | undefined {
	if (text.startsWith(ADD)) return { kind: "add", path: text.slice(ADD.length) };
	if (text.startsWith(DELETE)) return { kind: "delete", path: text.slice(DELETE.length) };
	if (text.startsWith(UPDATE)) return { kind: "update", path: text.slice(UPDATE.length) };
	return undefined;
}

function assertPatchPath(path: string): void {
	if (path.length === 0) throw parseError("empty path in patch header");
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path))
		throw parseError("absolute paths are not allowed");
}

function isHeaderOrEnd(text: string): boolean {
	return text === END || text.startsWith(ADD) || text.startsWith(DELETE) || text.startsWith(UPDATE);
}

function splitLines(input: string): readonly SourceLine[] {
	const matches = input.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g);
	const lines: SourceLine[] = [];
	for (const match of matches) {
		const rawText = match[1] ?? "";
		const newline = match[2] ?? "";
		const text = lines.length === 0 ? rawText.replace(/^\uFEFF/, "") : rawText;
		if (text.length === 0 && newline.length === 0) break;
		lines.push(Object.freeze({ text, newline }));
	}
	return Object.freeze(lines);
}

function normalizeEnvelope(lines: readonly SourceLine[]): readonly SourceLine[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.text === "") start += 1;
	while (end > start && lines[end - 1]?.text === "") end -= 1;
	let normalized = lines.slice(start, end);
	const first = normalized[0]?.text;
	const last = normalized[normalized.length - 1]?.text;
	if ((first === "```" || first === "```patch" || first === "```diff") && last === "```") {
		normalized = normalized.slice(1, -1);
		start = 0;
		end = normalized.length;
		while (start < end && normalized[start]?.text === "") start += 1;
		while (end > start && normalized[end - 1]?.text === "") end -= 1;
		normalized = normalized.slice(start, end);
	}
	return Object.freeze(normalized);
}

function parseError(message: string): SyntaxError {
	return new SyntaxError(`Invalid V4A patch: ${message}`);
}
