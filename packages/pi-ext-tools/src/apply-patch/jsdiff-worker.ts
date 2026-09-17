import type { StructuredPatch, StructuredPatchHunk } from "diff";
import type {
	AppliedPatchHunk,
	ApplyPatchHunkSnapshot,
	PreparedPatchUpdate,
	RejectedPatchHunk,
} from "./outcome.js";
import type { V4aUpdateHunk, V4aUpdateLine } from "./parser.js";

const MAX_FILE_SIZE = 32 * 1024 * 1024;
const SNAPSHOT_CONTEXT = 3;

export interface JsDiffHunkInput {
	readonly unifiedDiff: string;
	readonly hunk: V4aUpdateHunk;
}

export interface JsDiffWorkerData {
	readonly before: Uint8Array;
	readonly hunks: readonly JsDiffHunkInput[];
	readonly fuzzFactor: number;
	readonly snapshotPath: string;
}

interface TextLine {
	text: string;
	end: string;
	bom?: true;
}

interface WorkerMessage {
	readonly kind: "result" | "error";
	readonly value?: PreparedPatchUpdate;
	readonly message?: string;
}

function stripEol(text: string): string {
	return text.replace(/\r\n$|\n$|\r$/, "");
}
function findLastLine(
	lines: readonly V4aUpdateLine[],
	excludedKind: V4aUpdateLine["kind"],
): V4aUpdateLine | undefined {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line !== undefined && line.kind !== excludedKind) return line;
	}
	return undefined;
}

function oldSideTexts(hunk: V4aUpdateHunk): readonly string[] {
	return hunk.lines.filter((line) => line.kind !== "add").map((line) => stripEol(line.text));
}

function textLines(bytes: Uint8Array): readonly TextLine[] {
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	const parts = text.split(/(\r\n|\n|\r)/);
	const lines: TextLine[] = [];
	for (let index = 0; index < parts.length; index += 2) {
		const value = parts[index];
		if (value === undefined || (index === parts.length - 1 && value === "")) continue;
		const bom = lines.length === 0 && value.startsWith("\uFEFF");
		lines.push({
			text: bom ? value.slice(1) : value,
			end: parts[index + 1] ?? "",
			...(bom ? { bom: true } : {}),
		});
	}
	return lines;
}

function encodeLines(lines: readonly TextLine[]): Uint8Array {
	const text = lines.map((line) => `${line.text}${line.end}`).join("");
	return new TextEncoder().encode(`${lines[0]?.bom === true ? "\uFEFF" : ""}${text}`);
}

function lfView(lines: readonly TextLine[]): string {
	if (lines.length === 0) return "";
	let out = lines.map((line) => line.text).join("\n");
	if (lines.at(-1)?.end !== "") out += "\n";
	return out;
}

function findExactStarts(haystack: readonly string[], needle: readonly string[]): number[] {
	if (needle.length === 0) return [];
	const starts: number[] = [];
	for (let index = 0; index + needle.length <= haystack.length; index += 1) {
		let matched = true;
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (haystack[index + offset] !== needle[offset]) {
				matched = false;
				break;
			}
		}
		if (matched) starts.push(index);
	}
	return starts;
}

function anchorConstraint(
	lines: readonly TextLine[],
	hunk: V4aUpdateHunk,
): { readonly prefixLines: number } | RejectedPatchHunk {
	let start = 0;
	const anchors = hunk.anchors ?? (hunk.anchor === undefined ? [] : [hunk.anchor]);
	for (const anchor of anchors) {
		const candidates: number[] = [];
		for (let index = start; index < lines.length; index += 1)
			if (lines[index]?.text.includes(anchor)) candidates.push(index);
		if (candidates.length === 0) return { kind: "context_not_found", hunkIndex: 0 };
		if (candidates.length > 1)
			return {
				kind: "ambiguous_exact",
				hunkIndex: 0,
				candidateStartLines: candidates.map((line) => line + 1),
			};
		start = (candidates[0] ?? 0) + 1;
	}
	return { prefixLines: start };
}

function nearbyEnd(original: readonly TextLine[], start: number, oldLength: number): string {
	return (
		original[start]?.end || original[start - 1]?.end || original[start + oldLength]?.end || "\n"
	);
}

function changeCounts(changes: readonly StructuredPatchHunk[]): {
	readonly addedLines: number;
	readonly removedLines: number;
} {
	let addedLines = 0;
	let removedLines = 0;
	for (const change of changes)
		for (const line of change.lines) {
			if (line.startsWith("+") && !line.startsWith("+++")) addedLines += 1;
			else if (line.startsWith("-") && !line.startsWith("---")) removedLines += 1;
		}
	return { addedLines, removedLines };
}

function replacementTexts(change: StructuredPatchHunk): readonly string[] {
	const texts: string[] = [];
	for (const line of change.lines) {
		if (line.startsWith("\\")) continue;
		if (line.startsWith("+") || line.startsWith(" ")) texts.push(line.slice(1));
	}
	return texts;
}

function applyLastNewline(
	result: TextLine[],
	original: readonly TextLine[],
	hunk: V4aUpdateHunk,
	afterView: string | undefined,
): void {
	if (result.length === 0) return;
	const last = result[result.length - 1];
	const newSide = findLastLine(hunk.lines, "remove");
	const oldSide = findLastLine(hunk.lines, "add");
	if (last === undefined) return;
	if (newSide?.noNewline === true) last.end = "";
	else if (oldSide?.noNewline === true && newSide?.noNewline !== true)
		last.end = last.end || nearbyEnd(original, original.length - 1, 0) || "\n";
	else if (
		original.at(-1)?.end === "" &&
		newSide?.noNewline !== true &&
		afterView?.endsWith("\n") !== true
	)
		last.end = "";
	else if (afterView?.endsWith("\n") === true && last.end === "")
		last.end = nearbyEnd(original, original.length - 1, 0) || "\n";
	for (let index = 0; index < result.length - 1; index += 1) {
		const line = result[index];
		if (line !== undefined && line.end === "") line.end = nearbyEnd(original, index, 0) || "\n";
	}
}

function rebuildExactBytes(
	original: readonly TextLine[],
	hunk: V4aUpdateHunk,
	start: number,
	afterView: string,
): Uint8Array {
	const result: TextLine[] = original.map((line) => ({ ...line }));
	let cursor = start;
	let removedEnds: string[] = [];
	let addedCount = 0;
	for (const line of hunk.lines) {
		if (line.kind === "remove") {
			removedEnds.push(result[cursor]?.end ?? "");
			result.splice(cursor, 1);
			continue;
		}
		if (line.kind === "context") {
			cursor += 1;
			removedEnds = [];
			addedCount = 0;
			continue;
		}
		const end =
			line.noNewline === true
				? ""
				: (removedEnds[addedCount] ??
					removedEnds.at(-1) ??
					result[cursor]?.end ??
					nearbyEnd(result, cursor, 0));
		result.splice(cursor, 0, { text: stripEol(line.text), end });
		cursor += 1;
		addedCount += 1;
	}
	applyLastNewline(result, original, hunk, afterView);
	return encodeLines(result);
}

function rebuildBytes(
	original: readonly TextLine[],
	hunk: V4aUpdateHunk,
	changes: readonly StructuredPatchHunk[],
	afterView: string,
): Uint8Array {
	if (changes.length === 0) return encodeLines(original);
	const result: TextLine[] = original.map((line) => ({ ...line }));
	let shift = 0;
	for (const change of changes) {
		const start = Math.max(0, change.oldStart - 1 + shift);
		const oldLength = change.oldLines;
		const preferred = nearbyEnd(result, start, oldLength);
		const texts = replacementTexts(change);
		const replacement = texts.map((text, index) => ({
			text,
			end: result[start + index]?.end || preferred,
		}));
		result.splice(start, oldLength, ...replacement);
		shift += replacement.length - oldLength;
	}
	applyLastNewline(result, original, hunk, afterView);
	return encodeLines(result);
}

function snapshotFromChange(
	path: string,
	hunkIndex: number,
	change: StructuredPatchHunk,
	beforeLines: readonly string[],
	afterLines: readonly string[],
): ApplyPatchHunkSnapshot {
	const beforeStart = Math.max(0, change.oldStart - 1 - SNAPSHOT_CONTEXT);
	const afterStart = Math.max(0, change.newStart - 1 - SNAPSHOT_CONTEXT);
	const beforeEnd = Math.min(
		beforeLines.length,
		change.oldStart - 1 + Math.max(change.oldLines, 0) + SNAPSHOT_CONTEXT,
	);
	const afterEnd = Math.min(
		afterLines.length,
		change.newStart - 1 + Math.max(change.newLines, 0) + SNAPSHOT_CONTEXT,
	);
	return Object.freeze({
		path,
		hunkIndex,
		startLine: beforeStart + 1,
		afterStartLine: afterStart + 1,
		before: Object.freeze(beforeLines.slice(beforeStart, beforeEnd)),
		after: Object.freeze(afterLines.slice(afterStart, afterEnd)),
	});
}

function parseOneHunk(
	parsePatch: (diff: string) => StructuredPatch[],
	unifiedDiff: string,
	hunk: V4aUpdateHunk,
): StructuredPatch | RejectedPatchHunk {
	let parsed: StructuredPatch[];
	try {
		parsed = parsePatch(unifiedDiff);
	} catch {
		return { kind: "context_not_found", hunkIndex: 0 };
	}
	const file = parsed[0];
	const parsedHunk = file?.hunks[0];
	if (
		parsed.length !== 1 ||
		file === undefined ||
		file.hunks.length !== 1 ||
		parsedHunk === undefined ||
		file.isBinary === true ||
		file.isRename === true ||
		file.isCopy === true
	)
		return { kind: "context_not_found", hunkIndex: 0 };
	const oldCount = hunk.lines.filter((line) => line.kind !== "add").length;
	const newCount = hunk.lines.filter((line) => line.kind !== "remove").length;
	if (parsedHunk.oldLines !== oldCount || parsedHunk.newLines !== newCount)
		return { kind: "context_not_found", hunkIndex: 0 };
	return file;
}

function processHunks(
	data: JsDiffWorkerData,
	diff: {
		readonly applyPatch: (
			source: string,
			patch: StructuredPatch,
			options: { readonly fuzzFactor: number; readonly autoConvertLineEndings: boolean },
		) => string | false;
		readonly parsePatch: (diff: string) => StructuredPatch[];
		readonly structuredPatch: (
			oldFileName: string,
			newFileName: string,
			oldStr: string,
			newStr: string,
			oldHeader: string | undefined,
			newHeader: string | undefined,
			options: { readonly context: number },
		) => StructuredPatch;
	},
): PreparedPatchUpdate {
	if (data.before.length > MAX_FILE_SIZE)
		throw new Error(`file_too_large: ${data.before.length} bytes`);
	const outcomes: AppliedPatchHunk[] = [];
	const rejected: RejectedPatchHunk[] = [];
	const snapshots: ApplyPatchHunkSnapshot[] = [];
	let addedLines = 0;
	let removedLines = 0;
	let mode: "exact" | "fuzzy" | undefined;
	let after = data.before;
	for (const [index, input] of data.hunks.entries()) {
		const hunkIndex = index + 1;
		const hunk = input.hunk;
		if (after.length > MAX_FILE_SIZE) throw new Error(`file_too_large: ${after.length} bytes`);
		let original: readonly TextLine[];
		try {
			original = textLines(after);
		} catch {
			throw new Error("Patch update is not valid UTF-8 text");
		}
		const constraint = anchorConstraint(original, hunk);
		if ("kind" in constraint) {
			rejected.push({ ...constraint, hunkIndex });
			continue;
		}
		const oldTexts = oldSideTexts(hunk);
		const oldLength = oldTexts.length;
		const anchored = original.slice(constraint.prefixLines);
		const eofLines = hunk.endOfFile === undefined ? 0 : Math.max(0, anchored.length - oldLength);
		const prefixLines = constraint.prefixLines + eofLines;
		const searchable = original.slice(prefixLines);
		let insertAt = prefixLines;
		if (oldLength === 0) {
			if (hunk.endOfFile === true) insertAt = original.length;
			else insertAt = prefixLines;
		}
		const exactStarts = findExactStarts(
			searchable.map((line) => line.text),
			oldTexts,
		).map((start) => start + prefixLines);
		if (oldLength > 0 && exactStarts.length > 1) {
			rejected.push({
				kind: "ambiguous_exact",
				hunkIndex,
				candidateStartLines: exactStarts.map((start) => start + 1),
			});
			continue;
		}
		const parsed = parseOneHunk(diff.parsePatch, input.unifiedDiff, hunk);
		if ("kind" in parsed) {
			rejected.push({ ...parsed, hunkIndex });
			continue;
		}
		const parsedHunk = parsed.hunks[0];
		if (parsedHunk === undefined) {
			rejected.push({ kind: "context_not_found", hunkIndex });
			continue;
		}
		if (oldLength === 0) {
			parsedHunk.oldStart = insertAt + 1;
			parsedHunk.newStart = insertAt + 1;
		} else if (exactStarts.length === 1) {
			const start = exactStarts[0] ?? 0;
			parsedHunk.oldStart = start + 1;
			parsedHunk.newStart = start + 1;
		}
		const sourceView = lfView(original);
		let applied = diff.applyPatch(sourceView, parsed, {
			fuzzFactor: 0,
			autoConvertLineEndings: false,
		});
		let match: "exact" | "fuzzy" = "exact";
		if (applied === false && exactStarts.length === 0 && data.fuzzFactor > 0) {
			applied = diff.applyPatch(sourceView, parsed, {
				fuzzFactor: data.fuzzFactor,
				autoConvertLineEndings: false,
			});
			match = "fuzzy";
		}
		if (applied === false) {
			rejected.push({ kind: "context_not_found", hunkIndex });
			continue;
		}
		const changes = diff
			.structuredPatch("before", "after", sourceView, applied, undefined, undefined, {
				context: 0,
			})
			.hunks.filter((change) =>
				change.lines.some((line) => line.startsWith("+") || line.startsWith("-")),
			);
		const rebuilt =
			match === "exact"
				? rebuildExactBytes(
						original,
						hunk,
						oldLength === 0 ? insertAt : (exactStarts[0] ?? insertAt),
						applied,
					)
				: rebuildBytes(original, hunk, changes, applied);
		if (rebuilt.length > MAX_FILE_SIZE) throw new Error(`file_too_large: ${rebuilt.length} bytes`);
		const rebuiltLines = textLines(rebuilt);
		const rebuiltView = lfView(rebuiltLines);
		const finalChanges = diff
			.structuredPatch("before", "after", sourceView, rebuiltView, undefined, undefined, {
				context: 0,
			})
			.hunks.filter((change) =>
				change.lines.some((line) => line.startsWith("+") || line.startsWith("-")),
			);
		const counts = changeCounts(finalChanges);
		addedLines += counts.addedLines;
		removedLines += counts.removedLines;
		let startLine: number;
		let length: number;
		if (finalChanges.length === 0) {
			startLine = oldLength === 0 ? insertAt + 1 : (exactStarts[0] ?? prefixLines) + 1;
			length = 0;
		} else {
			const starts = finalChanges.map((change) => change.oldStart);
			const ends = finalChanges.map((change) =>
				change.oldLines === 0 ? change.oldStart : change.oldStart + change.oldLines,
			);
			startLine = Math.min(...starts);
			const end = Math.max(...ends);
			length = finalChanges.every((change) => change.oldLines === 0) ? 0 : end - startLine;
		}
		outcomes.push({ kind: "applied", hunkIndex, startLine, length, match });
		const beforeTexts = original.map((line) => line.text);
		const afterTexts = rebuiltLines.map((line) => line.text);
		for (const change of finalChanges)
			snapshots.push(
				snapshotFromChange(data.snapshotPath, hunkIndex, change, beforeTexts, afterTexts),
			);
		if (match === "fuzzy") mode = "fuzzy";
		else mode ??= "exact";
		after = rebuilt;
	}
	return {
		after,
		mode,
		addedLines,
		removedLines,
		outcomes: Object.freeze(outcomes),
		rejected: Object.freeze(rejected),
		snapshots: Object.freeze(snapshots),
	};
}

async function main(): Promise<void> {
	const { parentPort, workerData } = await import("node:worker_threads");
	const diff = await import("diff");
	const send = (message: WorkerMessage): void => {
		parentPort?.postMessage(message);
		parentPort?.close();
	};
	try {
		send({
			kind: "result",
			value: processHunks(workerData as JsDiffWorkerData, {
				applyPatch: diff.applyPatch,
				parsePatch: diff.parsePatch,
				structuredPatch: diff.structuredPatch,
			}),
		});
	} catch (error) {
		send({
			kind: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

await main();
