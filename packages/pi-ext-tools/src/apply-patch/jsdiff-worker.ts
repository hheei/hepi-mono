// The worker must not import the ext-core barrel: it would load every ext-core module into a fresh
// thread before a single hunk is diffed, which measured ~220ms per patch operation. `./errors` is
// the lean subpath that carries just the error helpers.
import { errorMessage } from "@hheei/pi-ext-core/errors";
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

function normalizeUnicode(value: string): string {
	return value
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu, "-")
		.replace(/[\u2018\u2019\u201a\u201b]/gu, "'")
		.replace(/[\u201c\u201d\u201e\u201f]/gu, '"')
		.replace(
			/[\u00a0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000]/gu,
			" ",
		);
}

type MatchTier = "exact" | "trimEnd" | "trim" | "ambiguous" | "none";

interface TieredMatchResult {
	readonly starts: readonly number[];
	readonly tier: MatchTier;
	readonly indentShift?: string;
	readonly eofTrimmedCount?: number;
}

function findTieredStarts(
	haystack: readonly string[],
	needle: readonly string[],
): TieredMatchResult {
	if (needle.length === 0) return { starts: [], tier: "exact" };

	// Tier 1: exact match
	const exactStarts: number[] = [];
	for (let index = 0; index + needle.length <= haystack.length; index += 1) {
		let matched = true;
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (haystack[index + offset] !== needle[offset]) {
				matched = false;
				break;
			}
		}
		if (matched) exactStarts.push(index);
	}
	if (exactStarts.length === 1) return { starts: exactStarts, tier: "exact" };
	if (exactStarts.length > 1) return { starts: exactStarts, tier: "ambiguous" };

	// Tier 2: trimEnd + unicode normalization
	const normHaystack2 = haystack.map((line) => normalizeUnicode(line).trimEnd());
	const normNeedle2 = needle.map((line) => normalizeUnicode(line).trimEnd());
	const tier2Starts: number[] = [];
	for (let index = 0; index + needle.length <= haystack.length; index += 1) {
		let matched = true;
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (normHaystack2[index + offset] !== normNeedle2[offset]) {
				matched = false;
				break;
			}
		}
		if (matched) tier2Starts.push(index);
	}
	if (tier2Starts.length === 1) return { starts: tier2Starts, tier: "trimEnd" };
	if (tier2Starts.length > 1) return { starts: tier2Starts, tier: "ambiguous" };

	// Tier 3: trim (indentation tolerance) + unicode normalization
	const normHaystack3 = haystack.map((line) => normalizeUnicode(line).trim());
	const normNeedle3 = needle.map((line) => normalizeUnicode(line).trim());
	const tier3Starts: number[] = [];
	for (let index = 0; index + needle.length <= haystack.length; index += 1) {
		let matched = true;
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (normHaystack3[index + offset] !== normNeedle3[offset]) {
				matched = false;
				break;
			}
		}
		if (matched) tier3Starts.push(index);
	}
	if (tier3Starts.length === 1) {
		return { starts: tier3Starts, tier: "trim" };
	}
	if (tier3Starts.length > 1) return { starts: tier3Starts, tier: "ambiguous" };

	// EOF Tail match: when LLM context extends past EOF with trailing empty/whitespace lines
	const trimmedNeedle = [...needle];
	while (trimmedNeedle.length > 0 && trimmedNeedle[trimmedNeedle.length - 1]?.trim() === "") {
		trimmedNeedle.pop();
	}
	if (trimmedNeedle.length > 0 && trimmedNeedle.length < needle.length) {
		const tailMatch = findTieredStarts(haystack, trimmedNeedle);
		if (tailMatch.starts.length === 1) {
			const start = tailMatch.starts[0] ?? 0;
			if (start + trimmedNeedle.length === haystack.length) {
				return { ...tailMatch, eofTrimmedCount: needle.length - trimmedNeedle.length };
			}
		}
	}

	return { starts: [], tier: "none" };
}

function adjustIndent(
	cleanText: string,
	lastOrigIndent: string,
	lastHunkIndent: string,
	indentMap?: ReadonlyMap<string, string>,
): string {
	if (cleanText.trim() === "") return "";
	const curHunkIndent = cleanText.match(/^\s*/)?.[0] ?? "";
	if (indentMap?.has(curHunkIndent)) {
		const mapped = indentMap.get(curHunkIndent) ?? "";
		return `${mapped}${cleanText.trimStart()}`;
	}
	const diff = curHunkIndent.length - lastHunkIndent.length;
	const targetLen = Math.max(0, lastOrigIndent.length + diff);
	if (targetLen === 0) return cleanText.trimStart();
	if (targetLen <= lastOrigIndent.length) {
		return `${lastOrigIndent.slice(0, targetLen)}${cleanText.trimStart()}`;
	}
	const extra = curHunkIndent.slice(lastHunkIndent.length);
	return `${lastOrigIndent}${extra}${cleanText.trimStart()}`;
}

function findDiagnosticHint(
	searchable: readonly string[],
	needle: readonly string[],
	prefixLines: number,
): string | undefined {
	if (needle.length === 0) return undefined;
	if (searchable.length < needle.length) {
		return `context exceeds file length (file has ${prefixLines + searchable.length} lines, but hunk context expects ${needle.length} lines)`;
	}
	const firstNeedle = needle[0] ?? "";
	const normNeedle = normalizeUnicode(firstNeedle).trim();
	if (normNeedle === "") return undefined;
	for (let index = 0; index < searchable.length; index += 1) {
		const line = searchable[index] ?? "";
		if (normalizeUnicode(line).trim() === normNeedle) {
			const lineNum = prefixLines + index + 1;
			return `found similar line with different indentation/whitespace at line ${lineNum}: expected "${firstNeedle.trim()}", actual "${line.trim()}"`;
		}
	}
	return undefined;
}

function isEofAnchor(anchor: string): boolean {
	const trimmed = anchor.trim();
	return /^(?:end\s+of\s+file|eof|\*{0,3}\s*end\s+of\s+file\*{0,3})$/i.test(trimmed);
}

function anchorConstraint(
	lines: readonly TextLine[],
	hunk: V4aUpdateHunk,
): { readonly prefixLines: number; readonly endOfFile?: true } | RejectedPatchHunk {
	let start = 0;
	let endOfFile = hunk.endOfFile;
	const anchors = hunk.anchors ?? (hunk.anchor === undefined ? [] : [hunk.anchor]);
	for (let anchor of anchors) {
		if (isEofAnchor(anchor)) {
			endOfFile = true;
			continue;
		}
		const lineNumMatch = anchor.match(/^(?:line\s*)?(\d+)$/i);
		if (lineNumMatch?.[1]) {
			const lineNum = Number.parseInt(lineNumMatch[1], 10);
			if (lineNum > lines.length) {
				endOfFile = true;
			} else {
				start = Math.max(0, lineNum - 1);
			}
			continue;
		}
		// Handle git hunk headers: @@ -x,y +x,y @@ text or @@ -x,y +x,y @@
		const gitRangeMatch = anchor.match(
			/^-(?<oldStart>\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?(?:\s*@@\s*(?<trailing>.*))?$/,
		);
		if (gitRangeMatch?.groups) {
			const trailing = gitRangeMatch.groups.trailing?.trim();
			if (trailing) {
				anchor = trailing;
			} else {
				const oldStart = Number.parseInt(gitRangeMatch.groups.oldStart ?? "0", 10);
				if (oldStart > lines.length) {
					endOfFile = true;
				} else {
					start = Math.max(0, oldStart - 1);
				}
				continue;
			}
		}
		const candidates: number[] = [];
		for (let index = start; index < lines.length; index += 1)
			if (lines[index]?.text.includes(anchor)) candidates.push(index);
		if (candidates.length === 0) {
			// Try normalized anchor
			const normAnchor = normalizeUnicode(anchor).trim();
			for (let index = start; index < lines.length; index += 1) {
				const line = lines[index]?.text ?? "";
				if (normalizeUnicode(line).includes(normAnchor)) candidates.push(index);
			}
			if (candidates.length === 0) {
				return { kind: "context_not_found", hunkIndex: 0, hint: `anchor "${anchor}" not found` };
			}
		}
		if (candidates.length > 1)
			return {
				kind: "ambiguous_exact",
				hunkIndex: 0,
				candidateStartLines: candidates.map((line) => line + 1),
			};
		start = (candidates[0] ?? 0) + 1;
	}
	return { prefixLines: start, ...(endOfFile === true ? { endOfFile: true as const } : {}) };
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
	tier: MatchTier = "exact",
): Uint8Array {
	const result: TextLine[] = original.map((line) => ({ ...line }));
	let cursor = start;
	let removedEnds: string[] = [];
	let addedCount = 0;
	let lastOrigIndent = "";
	let lastHunkIndent = "";
	const indentMap = new Map<string, string>();
	for (const line of hunk.lines) {
		const cleanText = stripEol(line.text);
		if (line.kind === "remove") {
			const origText = result[cursor]?.text ?? "";
			lastOrigIndent = origText.match(/^\s*/)?.[0] ?? "";
			lastHunkIndent = cleanText.match(/^\s*/)?.[0] ?? "";
			indentMap.set(lastHunkIndent, lastOrigIndent);
			removedEnds.push(result[cursor]?.end ?? "");
			result.splice(cursor, 1);
			continue;
		}
		if (line.kind === "context") {
			if (cursor < result.length) {
				const origText = result[cursor]?.text ?? "";
				lastOrigIndent = origText.match(/^\s*/)?.[0] ?? "";
				lastHunkIndent = cleanText.match(/^\s*/)?.[0] ?? "";
				indentMap.set(lastHunkIndent, lastOrigIndent);
				cursor += 1;
				removedEnds = [];
				addedCount = 0;
			}
			continue;
		}
		if (cursor > result.length) cursor = result.length;
		const end =
			line.noNewline === true
				? ""
				: (removedEnds[addedCount] ??
					removedEnds.at(-1) ??
					result[cursor]?.end ??
					nearbyEnd(result, cursor, 0));
		let addText = cleanText;
		if (tier === "trim" && (lastOrigIndent !== "" || lastHunkIndent !== "")) {
			addText = adjustIndent(cleanText, lastOrigIndent, lastHunkIndent, indentMap);
		}
		result.splice(cursor, 0, { text: addText, end });
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
		const isEof = constraint.endOfFile === true || hunk.endOfFile === true;
		const anchored = original.slice(constraint.prefixLines);
		const eofLines = isEof ? Math.max(0, anchored.length - oldLength) : 0;
		const prefixLines = constraint.prefixLines + eofLines;
		const searchable = original.slice(prefixLines);
		let insertAt = prefixLines;
		if (oldLength === 0) {
			if (isEof || prefixLines >= original.length) insertAt = original.length;
			else insertAt = prefixLines;
		}
		const tieredMatch = findTieredStarts(
			searchable.map((line) => line.text),
			oldTexts,
		);
		const matchedStarts = tieredMatch.starts.map((start) => start + prefixLines);
		if (oldLength > 0 && tieredMatch.tier === "ambiguous") {
			rejected.push({
				kind: "ambiguous_exact",
				hunkIndex,
				candidateStartLines: matchedStarts.map((start) => start + 1),
			});
			continue;
		}
		const sourceView = lfView(original);
		let parsed: StructuredPatch | RejectedPatchHunk;
		const shouldUseSynthDiff =
			oldLength > 0 &&
			(tieredMatch.tier === "trimEnd" ||
				tieredMatch.tier === "trim" ||
				(tieredMatch.eofTrimmedCount ?? 0) > 0);
		if (shouldUseSynthDiff) {
			// Synthesize a structured patch aligned with the original lines so diff.applyPatch succeeds
			const matchStart = matchedStarts[0] ?? prefixLines;
			let origCursor = matchStart;
			let lastOrigIndent = "";
			let lastHunkIndent = "";
			const indentMap = new Map<string, string>();
			const bodyLines: string[] = [];
			let emittedOld = 0;
			let emittedNew = 0;
			for (const line of hunk.lines) {
				const cleanText = stripEol(line.text);
				if (line.kind === "context") {
					if (origCursor < original.length) {
						const origLine = original[origCursor];
						const text = origLine?.text ?? cleanText;
						lastOrigIndent = text.match(/^\s*/)?.[0] ?? "";
						lastHunkIndent = cleanText.match(/^\s*/)?.[0] ?? "";
						indentMap.set(lastHunkIndent, lastOrigIndent);
						bodyLines.push(` ${text}\n`);
						if (origLine?.end === "") bodyLines.push("\\ No newline at end of file\n");
						origCursor += 1;
						emittedOld += 1;
						emittedNew += 1;
					}
					continue;
				}
				if (line.kind === "remove") {
					const origLine = original[origCursor];
					const text = origLine?.text ?? cleanText;
					lastOrigIndent = text.match(/^\s*/)?.[0] ?? "";
					lastHunkIndent = cleanText.match(/^\s*/)?.[0] ?? "";
					indentMap.set(lastHunkIndent, lastOrigIndent);
					bodyLines.push(`-${text}\n`);
					if (origLine?.end === "" || line.noNewline === true) {
						bodyLines.push("\\ No newline at end of file\n");
					}
					origCursor += 1;
					emittedOld += 1;
					continue;
				}
				let addText = cleanText;
				if (tieredMatch.tier === "trim" && (lastOrigIndent !== "" || lastHunkIndent !== "")) {
					addText = adjustIndent(cleanText, lastOrigIndent, lastHunkIndent, indentMap);
				}
				bodyLines.push(`+${addText}\n`);
				if (line.noNewline === true) bodyLines.push("\\ No newline at end of file\n");
				emittedNew += 1;
			}
			const diffLines: string[] = [
				"--- a/target\n",
				"+++ b/target\n",
				`@@ -${matchStart + 1},${emittedOld} +${matchStart + 1},${emittedNew} @@\n`,
				...bodyLines,
			];
			const synthDiff = diffLines.join("");
			try {
				parsed = diff.parsePatch(synthDiff)[0] ?? { kind: "context_not_found", hunkIndex: 0 };
			} catch {
				parsed = parseOneHunk(diff.parsePatch, input.unifiedDiff, hunk);
			}
		} else {
			parsed = parseOneHunk(diff.parsePatch, input.unifiedDiff, hunk);
		}
		if ("kind" in parsed) {
			rejected.push({ ...parsed, hunkIndex });
			continue;
		}
		const parsedHunk = parsed.hunks[0];
		if (parsedHunk === undefined) {
			const hint = findDiagnosticHint(
				searchable.map((line) => line.text),
				oldTexts,
				prefixLines,
			);
			rejected.push({
				kind: "context_not_found",
				hunkIndex,
				...(hint !== undefined ? { hint } : {}),
			});
			continue;
		}
		if (oldLength === 0) {
			parsedHunk.oldStart = insertAt + 1;
			parsedHunk.newStart = insertAt + 1;
		} else if (matchedStarts.length === 1) {
			const start = matchedStarts[0] ?? 0;
			parsedHunk.oldStart = start + 1;
			parsedHunk.newStart = start + 1;
		}
		let applied = diff.applyPatch(sourceView, parsed, {
			fuzzFactor: 0,
			autoConvertLineEndings: false,
		});
		let match: "exact" | "fuzzy" = "exact";
		if (applied === false && matchedStarts.length === 0 && data.fuzzFactor > 0) {
			applied = diff.applyPatch(sourceView, parsed, {
				fuzzFactor: data.fuzzFactor,
				autoConvertLineEndings: false,
			});
			match = "fuzzy";
		}
		if (applied === false) {
			const hint = findDiagnosticHint(
				searchable.map((line) => line.text),
				oldTexts,
				prefixLines,
			);
			rejected.push({
				kind: "context_not_found",
				hunkIndex,
				...(hint !== undefined ? { hint } : {}),
			});
			continue;
		}
		const changes = diff
			.structuredPatch("before", "after", sourceView, applied, undefined, undefined, {
				context: 0,
			})
			.hunks.filter((change) =>
				change.lines.some((line) => line.startsWith("+") || line.startsWith("-")),
			);
		const canUseExactRebuild = matchedStarts.length === 1 || oldLength === 0;
		const rebuilt = canUseExactRebuild
			? rebuildExactBytes(
					original,
					hunk,
					oldLength === 0 ? insertAt : (matchedStarts[0] ?? insertAt),
					applied,
					tieredMatch.tier,
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
			startLine = oldLength === 0 ? insertAt + 1 : (matchedStarts[0] ?? prefixLines) + 1;
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
		const userVisibleMatch: "exact" | "fuzzy" =
			match === "fuzzy" || tieredMatch.tier !== "exact" || (tieredMatch.eofTrimmedCount ?? 0) > 0
				? "fuzzy"
				: "exact";
		outcomes.push({ kind: "applied", hunkIndex, startLine, length, match: userVisibleMatch });
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
			message: errorMessage(error),
		});
	}
}

await main();
