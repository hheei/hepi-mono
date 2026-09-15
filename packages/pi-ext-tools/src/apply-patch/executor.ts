import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	APPLY_PATCH_MAX_FILE_SIZE,
	createLocalPatchFs,
	FsTransportError,
	fileTooLarge,
	gcAgentPatchTemps,
	type PatchFs,
	publishPreparedFile,
	sftpTimeoutMs,
} from "./fs.js";
import { acquireMutationLock } from "./lock.js";
import { type MpatchRunResult, runMpatch } from "./mpatch.js";
import type {
	ApplyPatchAppliedOperation,
	ApplyPatchHunkSnapshot,
	ApplyPatchInWorkspaceResult,
	ApplyPatchOperationProgress,
	ApplyPatchProgress,
	ApplyPatchRejection,
	MpatchHunkOutcome,
} from "./outcome.js";
import {
	compileV4aUpdateToUnifiedDiff,
	findV4aPatchConflicts,
	operationTouchedPaths,
	parseV4aPatch,
	type V4aPatch,
	type V4aPatchOperation,
	type V4aUpdateOperation,
} from "./parser.js";
import { assertPatchPath } from "./paths.js";
import type { FuzzyApplyPatchPolicy } from "./policy.js";

const SNAPSHOT_MAX_LINES = 150;

export interface ApplyPatchInWorkspaceOptions {
	readonly workspaceRoot: string;
	readonly patch: string;
	readonly parsedPatch?: V4aPatch;
	readonly policy: FuzzyApplyPatchPolicy;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: ApplyPatchProgress) => void;
	readonly fs?: PatchFs;
	readonly lockKey?: string;
}

interface StageUpdateResult {
	readonly mode: "exact" | "fuzzy" | undefined;
	readonly outcomes: readonly Extract<MpatchHunkOutcome, { readonly kind: "applied" }>[];
	readonly rejected: readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[];
	readonly snapshots: readonly ApplyPatchHunkSnapshot[];
	readonly after: Uint8Array;
}

class PatchUpdateError extends Error {
	constructor(
		message: string,
		readonly diagnostics: readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[],
	) {
		super(message);
	}
}

function parentDir(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "." : path.slice(0, index);
}

function lineCount(content: Uint8Array | string | undefined): number {
	if (content === undefined || content.length === 0) return 0;
	const text = typeof content === "string" ? content : new TextDecoder().decode(content);
	const lines = text.split(/\r\n|\n|\r/);
	return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function hunkDelta(hunks: readonly V4aUpdateOperation["hunks"][number][]): {
	readonly addedLines: number;
	readonly removedLines: number;
} {
	let addedLines = 0;
	let removedLines = 0;
	for (const hunk of hunks)
		for (const line of hunk.lines)
			if (line.kind === "add") addedLines += 1;
			else if (line.kind === "remove") removedLines += 1;
	return { addedLines, removedLines };
}

function plannedDelta(
	operation: V4aPatchOperation,
	content: Uint8Array | undefined,
): { readonly addedLines: number; readonly removedLines: number } {
	if (operation.kind === "add")
		return { addedLines: lineCount(operation.content), removedLines: 0 };
	if (operation.kind === "delete") return { addedLines: 0, removedLines: lineCount(content) };
	return hunkDelta(operation.hunks);
}

function appliedDelta(
	operation: V4aPatchOperation,
	outcomes: readonly Extract<MpatchHunkOutcome, { readonly kind: "applied" }>[],
): { readonly addedLines: number; readonly removedLines: number } {
	if (operation.kind !== "update") return plannedDelta(operation, undefined);
	let addedLines = 0;
	let removedLines = 0;
	for (const outcome of outcomes) {
		const hunk = operation.hunks[outcome.hunkIndex - 1];
		if (hunk === undefined) continue;
		const delta = hunkDelta([hunk]);
		addedLines += delta.addedLines;
		removedLines += delta.removedLines;
	}
	return { addedLines, removedLines };
}

function progressScore(outcome: ApplyPatchAppliedOperation): number | undefined {
	let score: number | undefined;
	for (const hunk of outcome.outcomes)
		if (hunk.match === "fuzzy" && hunk.score !== undefined)
			score = score === undefined ? hunk.score : Math.min(score, hunk.score);
	return score;
}

function progressTotals(operations: readonly ApplyPatchOperationProgress[]): {
	readonly files: number;
	readonly addedLines: number;
	readonly removedLines: number;
} {
	const paths = new Set<string>();
	let addedLines = 0;
	let removedLines = 0;
	for (const operation of operations) {
		paths.add(operation.path);
		if (
			operation.status === "applied" ||
			operation.status === "fuzzy" ||
			operation.status === "partial"
		) {
			addedLines += operation.addedLines;
			removedLines += operation.removedLines;
		}
	}
	return { files: paths.size, addedLines, removedLines };
}

function splitTextLines(content: Uint8Array): readonly string[] {
	const lines = new TextDecoder().decode(content).split(/\r\n|\n|\r/);
	if (lines.at(-1) === "") lines.pop();
	return Object.freeze(lines);
}

function snapshotHunk(
	path: string,
	hunkIndex: number,
	outcome: Extract<MpatchHunkOutcome, { readonly kind: "applied" }>,
	hunk: V4aUpdateOperation["hunks"][number],
	before: Uint8Array,
	after: Uint8Array,
): ApplyPatchHunkSnapshot {
	const beforeLines = splitTextLines(before);
	const afterLines = splitTextLines(after);
	const beforeStart = Math.max(0, outcome.startLine - 1 - 3);
	const afterStart = Math.max(0, outcome.startLine - 1 - 3);
	const beforeEnd = Math.min(beforeLines.length, outcome.startLine - 1 + outcome.length + 3);
	const afterLength = hunk.lines.filter((line) => line.kind !== "remove").length;
	const afterEnd = Math.min(afterLines.length, afterStart + afterLength + 6);
	return Object.freeze({
		path,
		hunkIndex,
		startLine: beforeStart + 1,
		afterStartLine: afterStart + 1,
		before: Object.freeze(beforeLines.slice(beforeStart, beforeEnd)),
		after: Object.freeze(afterLines.slice(afterStart, afterEnd)),
	});
}

function fileSnapshot(
	path: string,
	before: Uint8Array | undefined,
	after: Uint8Array | undefined,
): ApplyPatchHunkSnapshot {
	return Object.freeze({
		path,
		hunkIndex: 1,
		startLine: 1,
		afterStartLine: 1,
		before: Object.freeze(
			(before === undefined ? [] : splitTextLines(before)).slice(0, SNAPSHOT_MAX_LINES),
		),
		after: Object.freeze(
			(after === undefined ? [] : splitTextLines(after)).slice(0, SNAPSHOT_MAX_LINES),
		),
	});
}

function hunkFailureSummary(
	diagnostics: readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[],
): string | undefined {
	const diagnostic = diagnostics[0];
	if (diagnostic === undefined) return undefined;
	switch (diagnostic.kind) {
		case "context_not_found":
			return "context not found";
		case "ambiguous_exact":
			return "exact context is ambiguous";
		case "ambiguous_fuzzy":
			return "fuzzy context is ambiguous";
		case "fuzzy_below_threshold":
			return "fuzzy score below threshold";
	}
}

function offsetRejectedOutcome(
	outcome: Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>,
	hunkIndex: number,
	prefixLines: number,
): Exclude<MpatchHunkOutcome, { readonly kind: "applied" }> {
	switch (outcome.kind) {
		case "ambiguous_exact":
			return {
				...outcome,
				hunkIndex,
				candidateStartLines: outcome.candidateStartLines.map((line) => line + prefixLines),
			};
		case "ambiguous_fuzzy":
			return {
				...outcome,
				hunkIndex,
				candidates: outcome.candidates.map((candidate) => ({
					...candidate,
					startLine: candidate.startLine + prefixLines,
				})),
			};
		case "fuzzy_below_threshold":
			return {
				...outcome,
				hunkIndex,
				best: { ...outcome.best, startLine: outcome.best.startLine + prefixLines },
			};
		default:
			return { ...outcome, hunkIndex };
	}
}

interface MpatchAttempt {
	readonly result: MpatchRunResult;
	readonly after?: Uint8Array;
}

async function checkedMpatch(
	cwd: string,
	operation: V4aUpdateOperation,
	fuzzFactor: number,
	signal?: AbortSignal,
): Promise<MpatchAttempt> {
	const source = join(cwd, ...operation.path.split("/"));
	const before = await readFile(source, signal === undefined ? undefined : { signal });
	const result = await runMpatch({
		cwd,
		unifiedDiff: compileV4aUpdateToUnifiedDiff(operation),
		fuzzFactor,
		dryRun: false,
		...(signal === undefined ? {} : { signal }),
	});
	if (result.status !== 0) {
		await writeFile(source, before, signal === undefined ? undefined : { signal });
		return { result };
	}
	return { result, after: await readFile(source) };
}

interface TextLine {
	readonly text: string;
	readonly end: string;
}

function textLines(bytes: Uint8Array): readonly TextLine[] {
	const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
	const parts = text.split(/(\r\n|\n|\r)/);
	const lines: TextLine[] = [];
	for (let index = 0; index < parts.length; index += 2) {
		const value = parts[index];
		if (value === undefined || (index === parts.length - 1 && value === "")) continue;
		lines.push({ text: value, end: parts[index + 1] ?? "" });
	}
	return lines;
}

function lineOffset(bytes: Uint8Array, count: number): number {
	let offset = 0;
	let lines = 0;
	while (offset < bytes.length && lines < count) {
		const byte = bytes[offset++];
		if (byte === 13) {
			if (bytes[offset] === 10) offset += 1;
			lines += 1;
		} else if (byte === 10) lines += 1;
	}
	return offset;
}

function anchorConstraint(
	bytes: Uint8Array,
	hunk: V4aUpdateOperation["hunks"][number],
):
	| { readonly prefixBytes: number; readonly prefixLines: number }
	| Exclude<MpatchHunkOutcome, { readonly kind: "applied" }> {
	let start = 0;
	const lines = textLines(bytes);
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
	return { prefixBytes: lineOffset(bytes, start), prefixLines: start };
}

function preserveUntouchedLines(
	before: Uint8Array,
	after: Uint8Array,
	prefixLines: number,
	startLine: number,
	oldLength: number,
	newLength: number,
	hunk: V4aUpdateOperation["hunks"][number],
): Uint8Array {
	const original = textLines(before);
	const changed = textLines(after);
	const start = startLine - 1;
	const preferred =
		original[start]?.end || original[start - 1]?.end || original[start + oldLength]?.end || "\n";
	const source = original.slice(start, start + oldLength);
	const replacement = changed
		.slice(start - prefixLines, start - prefixLines + newLength)
		.map((line, index) => ({
			text: line.text,
			end: line.end === "" ? "" : original[start + index]?.end || preferred,
		}));
	let sourceIndex = 0;
	let replacementIndex = 0;
	for (const line of hunk.lines) {
		const text = line.text.replace(/\r\n$|\n$|\r$/, "");
		const sourceMatch =
			line.kind === "add"
				? -1
				: source.findIndex((candidate, index) => index >= sourceIndex && candidate.text === text);
		const replacementMatch =
			line.kind === "remove"
				? -1
				: replacement.findIndex(
						(candidate, index) => index >= replacementIndex && candidate.text === text,
					);
		if (sourceMatch >= 0) sourceIndex = sourceMatch + 1;
		if (replacementMatch >= 0) replacementIndex = replacementMatch + 1;
		if (line.kind !== "context" || sourceMatch < 0 || replacementMatch < 0) continue;
		const sourceEnd = source[sourceMatch]?.end;
		const replacementLine = replacement[replacementMatch];
		if (sourceEnd !== undefined && replacementLine !== undefined && replacementLine.end !== "")
			replacementLine.end = sourceEnd;
	}
	const result = [
		...original.slice(0, start),
		...replacement,
		...original.slice(start + oldLength),
	];
	return new TextEncoder().encode(
		result
			.map((line, index) => {
				const end =
					index < result.length - 1
						? line.end || preferred
						: original.at(-1)?.end === ""
							? ""
							: line.end;
				return `${line.text}${end}`;
			})
			.join(""),
	);
}

const STAGING_PATH = "__apply_patch_target__";

async function stageUpdate(
	stagingRoot: string,
	operation: V4aUpdateOperation,
	policy: FuzzyApplyPatchPolicy,
	signal?: AbortSignal,
): Promise<StageUpdateResult> {
	const outcomes: Extract<MpatchHunkOutcome, { readonly kind: "applied" }>[] = [];
	const rejected: Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[] = [];
	const snapshots: ApplyPatchHunkSnapshot[] = [];
	const source = join(stagingRoot, STAGING_PATH);
	let mode: "exact" | "fuzzy" | undefined;
	let after: Uint8Array = await readFile(source);
	for (const [index, hunk] of operation.hunks.entries()) {
		const hunkIndex = index + 1;
		const beforeHunk = after;
		const constraint = anchorConstraint(beforeHunk, hunk);
		if ("kind" in constraint) {
			rejected.push({ ...constraint, hunkIndex });
			continue;
		}
		const delta = hunkDelta([hunk]);
		const oldLength = hunk.lines.length - delta.addedLines;
		const anchoredSuffix = beforeHunk.slice(constraint.prefixBytes);
		const eofLines =
			hunk.endOfFile === undefined ? 0 : Math.max(0, textLines(anchoredSuffix).length - oldLength);
		const prefixBytes = constraint.prefixBytes + lineOffset(anchoredSuffix, eofLines);
		const prefixLines = constraint.prefixLines + eofLines;
		await writeFile(
			source,
			beforeHunk.slice(prefixBytes),
			signal === undefined ? undefined : { signal },
		);
		const atomicOperation: V4aUpdateOperation = {
			kind: "update",
			path: STAGING_PATH,
			hunks: [hunk],
		};
		let attempt = await checkedMpatch(stagingRoot, atomicOperation, 0, signal);
		if (attempt.after === undefined && policy.minSimilarity !== 0)
			attempt = await checkedMpatch(stagingRoot, atomicOperation, policy.minSimilarity, signal);
		if (attempt.after === undefined) {
			await writeFile(source, beforeHunk, signal === undefined ? undefined : { signal });
			for (const outcome of attempt.result.outcomes)
				if (outcome.kind !== "applied")
					rejected.push(offsetRejectedOutcome(outcome, hunkIndex, prefixLines));
			continue;
		}
		const rawOutcome = attempt.result.outcomes.find(
			(outcome): outcome is Extract<MpatchHunkOutcome, { readonly kind: "applied" }> =>
				outcome.kind === "applied",
		);
		if (rawOutcome === undefined) {
			await writeFile(source, beforeHunk, signal === undefined ? undefined : { signal });
			rejected.push({ kind: "context_not_found", hunkIndex });
			continue;
		}
		const fullOutcome = {
			...rawOutcome,
			hunkIndex,
			startLine: rawOutcome.startLine + prefixLines,
		};
		after = preserveUntouchedLines(
			beforeHunk,
			attempt.after,
			prefixLines,
			fullOutcome.startLine,
			rawOutcome.length,
			Math.max(0, rawOutcome.length + delta.addedLines - delta.removedLines),
			hunk,
		);
		await writeFile(source, after, signal === undefined ? undefined : { signal });
		outcomes.push(fullOutcome);
		snapshots.push(
			snapshotHunk(
				operation.moveTo ?? operation.path,
				hunkIndex,
				fullOutcome,
				hunk,
				beforeHunk,
				after,
			),
		);
		if (rawOutcome.match === "fuzzy") mode = "fuzzy";
		else mode ??= "exact";
	}
	return { mode, outcomes, rejected, snapshots, after };
}

function initialRejections(patch: V4aPatch): {
	readonly rejected: ApplyPatchRejection[];
	readonly indices: Set<number>;
} {
	const rejected: ApplyPatchRejection[] = [];
	const indices = new Set<number>();
	for (const conflict of findV4aPatchConflicts(patch)) {
		const operationIndices = Object.freeze([...conflict.operationIndices]);
		for (const index of operationIndices) indices.add(index);
		rejected.push(
			Object.freeze({
				operationIndices,
				paths: Object.freeze([conflict.path]),
				error: conflict.message,
				diagnostics: Object.freeze([]),
			}),
		);
	}
	return { rejected, indices };
}

function rejection(
	index: number,
	paths: readonly string[],
	error: unknown,
	diagnostics: readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[] = [],
): ApplyPatchRejection {
	return Object.freeze({
		operationIndices: Object.freeze([index]),
		paths: Object.freeze([...paths]),
		error: error instanceof Error ? error.message : String(error),
		diagnostics: Object.freeze([...diagnostics]),
	});
}

async function prepareUpdateBytes(
	fs: PatchFs,
	operation: V4aUpdateOperation,
	policy: FuzzyApplyPatchPolicy,
	signal?: AbortSignal,
): Promise<{
	readonly bytes: Uint8Array;
	readonly before: Uint8Array;
	readonly mode: number | undefined;
	readonly stage: StageUpdateResult;
}> {
	const followed = await fs.statFollow(operation.path, signal);
	if (followed.kind === "missing")
		throw new Error(`Patch source does not exist: ${operation.path}`);
	if (followed.kind !== "file")
		throw new Error(`Patch path is not a regular file: ${operation.path}`);
	if (followed.size > APPLY_PATCH_MAX_FILE_SIZE) throw fileTooLarge(followed.size, operation.path);
	const before = await fs.readFollow(operation.path, signal, sftpTimeoutMs(followed.size));
	if (before.length > APPLY_PATCH_MAX_FILE_SIZE) throw fileTooLarge(before.length, operation.path);
	const stagingRoot = join(tmpdir(), `hepi-apply-patch-${randomUUID()}`);
	await mkdir(stagingRoot);
	try {
		await writeFile(
			join(stagingRoot, STAGING_PATH),
			before,
			followed.mode === undefined ? undefined : { mode: followed.mode },
		);
		const stage = await stageUpdate(stagingRoot, operation, policy, signal);
		if (operation.hunks.length > 0 && stage.outcomes.length === 0)
			throw new PatchUpdateError("One or more update hunks failed", stage.rejected);
		if (stage.after.length > APPLY_PATCH_MAX_FILE_SIZE)
			throw fileTooLarge(stage.after.length, operation.moveTo ?? operation.path);
		return { bytes: stage.after, before, mode: followed.mode, stage };
	} finally {
		await rm(stagingRoot, { recursive: true, force: true });
	}
}

function sourceChanged(path: string): Error {
	return new Error(`Patch source changed during patch preparation: ${path}`);
}

async function revalidateSourceBaseline(
	fs: PatchFs,
	path: string,
	before: Uint8Array,
	signal?: AbortSignal,
): Promise<void> {
	const meta = await fs.statFollow(path, signal);
	if (meta.kind !== "file" || meta.size > APPLY_PATCH_MAX_FILE_SIZE) throw sourceChanged(path);
	const current = await fs.readFollow(path, signal, sftpTimeoutMs(meta.size));
	if (current.length > APPLY_PATCH_MAX_FILE_SIZE || Buffer.compare(current, before) !== 0)
		throw sourceChanged(path);
}

async function revalidateDeleteBaseline(
	fs: PatchFs,
	path: string,
	meta: { readonly kind: string; readonly size: number; readonly mode?: number },
	before: Uint8Array | undefined,
	signal?: AbortSignal,
): Promise<void> {
	const current = await fs.lstat(path, signal);
	if (current.kind !== meta.kind || current.size !== meta.size || current.mode !== meta.mode)
		throw sourceChanged(path);
	if (before !== undefined) await revalidateSourceBaseline(fs, path, before, signal);
}

async function applyAdd(
	fs: PatchFs,
	index: number,
	operation: Extract<V4aPatchOperation, { readonly kind: "add" }>,
	signal?: AbortSignal,
): Promise<ApplyPatchAppliedOperation> {
	const existing = await fs.lstat(operation.path, signal);
	if (existing.kind !== "missing")
		throw new Error(`Patch add target already exists: ${operation.path}`);
	const bytes = Buffer.from(operation.content, "utf8");
	if (bytes.length > APPLY_PATCH_MAX_FILE_SIZE) throw fileTooLarge(bytes.length, operation.path);
	await publishPreparedFile(fs, operation.path, bytes, undefined, false, signal);
	return Object.freeze({
		operationIndex: index,
		kind: "add",
		paths: Object.freeze([operation.path]),
		outcomes: Object.freeze([]),
		snapshots: Object.freeze([fileSnapshot(operation.path, undefined, bytes)]),
	});
}

async function applyDelete(
	fs: PatchFs,
	index: number,
	operation: Extract<V4aPatchOperation, { readonly kind: "delete" }>,
	signal?: AbortSignal,
): Promise<{
	readonly outcome: ApplyPatchAppliedOperation;
	readonly before: Uint8Array | undefined;
}> {
	const meta = await fs.lstat(operation.path, signal);
	if (meta.kind === "missing") throw new Error(`Patch source does not exist: ${operation.path}`);
	if (meta.kind === "directory")
		throw new Error(`Patch path is not a regular file: ${operation.path}`);
	if (meta.kind === "file" && meta.size > APPLY_PATCH_MAX_FILE_SIZE)
		throw fileTooLarge(meta.size, operation.path);
	const before =
		meta.kind === "file"
			? await fs.readFollow(operation.path, signal, sftpTimeoutMs(meta.size))
			: undefined;
	if (before !== undefined && before.length > APPLY_PATCH_MAX_FILE_SIZE)
		throw fileTooLarge(before.length, operation.path);
	await revalidateDeleteBaseline(fs, operation.path, meta, before, signal);
	await fs.unlink(operation.path, signal);
	return {
		outcome: Object.freeze({
			operationIndex: index,
			kind: "delete",
			paths: Object.freeze([operation.path]),
			outcomes: Object.freeze([]),
			snapshots: Object.freeze([fileSnapshot(operation.path, before, undefined)]),
		}),
		before,
	};
}

interface UpdatePublishResult {
	readonly outcome: ApplyPatchAppliedOperation;
	readonly mode: "exact" | "fuzzy" | undefined;
	readonly rejectedHunks: readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[];
	readonly sourceError?: unknown;
	readonly sourceUnknown?: boolean;
}

async function applyUpdate(
	fs: PatchFs,
	index: number,
	operation: V4aUpdateOperation,
	policy: FuzzyApplyPatchPolicy,
	signal?: AbortSignal,
): Promise<UpdatePublishResult> {
	const prepared = await prepareUpdateBytes(fs, operation, policy, signal);
	const dest = operation.moveTo ?? (await fs.followLeaf(operation.path, signal));
	if (operation.moveTo !== undefined) {
		const destMeta = await fs.lstat(operation.moveTo, signal);
		if (destMeta.kind !== "missing")
			throw new Error(`Patch move destination already exists: ${operation.moveTo}`);
	}
	await publishPreparedFile(
		fs,
		dest,
		prepared.bytes,
		prepared.mode,
		operation.moveTo === undefined,
		signal,
		() => revalidateSourceBaseline(fs, operation.path, prepared.before, signal),
	);
	const destPaths = operation.moveTo === undefined ? [operation.path] : [operation.moveTo];
	const outcome = Object.freeze({
		operationIndex: index,
		kind: "update" as const,
		paths: Object.freeze(destPaths),
		outcomes: Object.freeze([...prepared.stage.outcomes]),
		snapshots: Object.freeze([...prepared.stage.snapshots]),
	});
	const result = {
		outcome,
		mode: prepared.stage.mode,
		rejectedHunks: prepared.stage.rejected,
	};
	if (operation.moveTo === undefined) return result;
	try {
		await revalidateSourceBaseline(fs, operation.path, prepared.before, signal);
		await fs.unlink(operation.path, signal);
		return {
			...result,
			outcome: Object.freeze({
				...outcome,
				paths: Object.freeze([operation.path, operation.moveTo]),
			}),
		};
	} catch (sourceError) {
		return {
			...result,
			sourceError,
			sourceUnknown: sourceError instanceof FsTransportError && sourceError.phase !== "write",
		};
	}
}

export async function applyPatchInWorkspace(
	options: ApplyPatchInWorkspaceOptions,
): Promise<ApplyPatchInWorkspaceResult> {
	options.signal?.throwIfAborted();
	const fs = options.fs ?? createLocalPatchFs(options.workspaceRoot);
	const patch = options.parsedPatch ?? parseV4aPatch(options.patch);
	for (const operation of patch.operations)
		for (const path of operationTouchedPaths(operation)) assertPatchPath(path);
	const initial = initialRejections(patch);
	const rejected: ApplyPatchRejection[] = [...initial.rejected];
	const unconfirmed: ApplyPatchRejection[] = [];
	const notApplied: ApplyPatchRejection[] = [];
	const applied: ApplyPatchAppliedOperation[] = [];
	const rejectedIndices = new Set(initial.indices);
	let exactUpdateCount = 0;
	let fuzzyUpdateCount = 0;
	let halt: "unconfirmed" | "not_applied" | undefined;
	const progressOperations: ApplyPatchOperationProgress[] = patch.operations.map(
		(operation, index) => ({
			operationIndex: index,
			kind: operation.kind,
			path: operation.kind === "update" ? (operation.moveTo ?? operation.path) : operation.path,
			...plannedDelta(operation, undefined),
			status: rejectedIndices.has(index) ? "rejected" : "pending",
		}),
	);
	const setStatus = (
		index: number,
		status: ApplyPatchOperationProgress["status"],
		outcome?: ApplyPatchAppliedOperation,
		update?: V4aUpdateOperation,
		partialReason?: string,
	): void => {
		const current = progressOperations[index];
		if (current === undefined) throw new Error(`Missing patch progress operation: ${index}`);
		const score = status === "fuzzy" && outcome !== undefined ? progressScore(outcome) : undefined;
		const { score: _score, ...rest } = current;
		progressOperations[index] = Object.freeze({
			...rest,
			...(update === undefined || outcome === undefined
				? {}
				: appliedDelta(update, outcome.outcomes)),
			status,
			...(score === undefined ? {} : { score }),
			...(status === "partial" && update !== undefined && outcome !== undefined
				? {
						appliedHunks: outcome.outcomes.length,
						totalHunks: update.hunks.length,
						...(partialReason === undefined ? {} : { partialReason }),
					}
				: {}),
		});
	};
	const emit = (stage: ApplyPatchProgress["stage"]): void => {
		const totals = progressTotals(progressOperations);
		options.onProgress?.(
			Object.freeze({
				stage,
				...totals,
				operations: Object.freeze([...progressOperations]),
			}),
		);
	};
	const markNotApplied = (index: number, operation: V4aPatchOperation): void => {
		setStatus(index, "not_applied");
		notApplied.push(rejection(index, operationTouchedPaths(operation), "NotApplied"));
	};
	const release = await acquireMutationLock(options.lockKey ?? fs.scope, options.signal);
	try {
		await gcAgentPatchTemps(
			fs,
			patch.operations.flatMap((operation) =>
				operationTouchedPaths(operation).map((path) => parentDir(path)),
			),
			options.signal,
		);
		emit("parsed");
		for (const [index, operation] of patch.operations.entries()) {
			if (rejectedIndices.has(index)) continue;
			if (halt !== undefined) {
				markNotApplied(index, operation);
				continue;
			}
			if (options.signal?.aborted) {
				if (applied.length === 0 && unconfirmed.length === 0)
					throw options.signal.reason ?? new Error("aborted");
				halt = "not_applied";
				markNotApplied(index, operation);
				continue;
			}
			try {
				if (operation.kind === "add") {
					const outcome = await applyAdd(fs, index, operation, options.signal);
					applied.push(outcome);
					setStatus(index, "applied", outcome);
				} else if (operation.kind === "delete") {
					const deleted = await applyDelete(fs, index, operation, options.signal);
					applied.push(deleted.outcome);
					const current = progressOperations[index];
					if (current !== undefined) {
						const { score: _score, ...rest } = current;
						progressOperations[index] = Object.freeze({
							...rest,
							...plannedDelta(operation, deleted.before),
							status: "applied" as const,
						});
					}
				} else {
					const published = await applyUpdate(fs, index, operation, options.policy, options.signal);
					if (published.mode === "exact") exactUpdateCount += 1;
					if (published.mode === "fuzzy") fuzzyUpdateCount += 1;
					applied.push(published.outcome);
					const partialReason =
						published.rejectedHunks.length === 0
							? undefined
							: (hunkFailureSummary(published.rejectedHunks) ?? "hunk rejected");
					if (published.rejectedHunks.length > 0)
						rejected.push(
							rejection(
								index,
								operationTouchedPaths(operation),
								"One or more update hunks failed",
								published.rejectedHunks,
							),
						);
					if (published.sourceError !== undefined) {
						if (published.sourceUnknown === true) {
							unconfirmed.push(rejection(index, [operation.path], published.sourceError));
							setStatus(index, "unconfirmed", published.outcome);
							halt = "unconfirmed";
						} else {
							rejected.push(rejection(index, [operation.path], published.sourceError));
							setStatus(
								index,
								"partial",
								published.outcome,
								operation,
								partialReason ?? String(published.sourceError),
							);
						}
					} else {
						setStatus(
							index,
							partialReason === undefined
								? published.mode === "fuzzy"
									? "fuzzy"
									: "applied"
								: "partial",
							published.outcome,
							operation,
							partialReason,
						);
					}
				}
			} catch (error) {
				if (options.signal?.aborted && applied.length === 0 && unconfirmed.length === 0)
					throw options.signal.reason ?? error;
				if (error instanceof FsTransportError) {
					const bucket = error.phase === "write" ? notApplied : unconfirmed;
					const status = error.phase === "write" ? "not_applied" : "unconfirmed";
					bucket.push(rejection(index, operationTouchedPaths(operation), error));
					setStatus(index, status);
					halt = status;
				} else if (error instanceof PatchUpdateError) {
					rejected.push(
						rejection(index, operationTouchedPaths(operation), error, error.diagnostics),
					);
					rejectedIndices.add(index);
					setStatus(index, "rejected");
				} else if (options.signal?.aborted) {
					notApplied.push(rejection(index, operationTouchedPaths(operation), error));
					setStatus(index, "not_applied");
					halt = "not_applied";
				} else {
					rejected.push(rejection(index, operationTouchedPaths(operation), error));
					rejectedIndices.add(index);
					setStatus(index, "rejected");
				}
			}
			emit("publishing");
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		if (halt !== undefined) {
			for (const [index, operation] of patch.operations.entries()) {
				if (progressOperations[index]?.status !== "pending") continue;
				markNotApplied(index, operation);
			}
		}
		emit("done");
		const totals = progressTotals(progressOperations);
		return Object.freeze({
			changedPaths: Object.freeze([
				...new Set(applied.flatMap((operation) => [...operation.paths])),
			]),
			addedLines: totals.addedLines,
			removedLines: totals.removedLines,
			operations: Object.freeze([...progressOperations]),
			operationCount: patch.operations.length,
			exactUpdateCount,
			fuzzyUpdateCount,
			applied: Object.freeze(applied),
			rejected: Object.freeze(rejected),
			unconfirmed: Object.freeze(unconfirmed),
			notApplied: Object.freeze(notApplied),
		});
	} finally {
		await release();
	}
}
