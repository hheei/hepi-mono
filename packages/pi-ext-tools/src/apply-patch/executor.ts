import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	APPLY_PATCH_MAX_FILE_SIZE,
	agentPatchTempName,
	createLocalPatchFs,
	FsTransportError,
	gcAgentPatchTemps,
	type PatchFs,
	sftpTimeoutMs,
} from "./fs.js";
import { acquireApplyPatchLock } from "./lock.js";
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

function baseName(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? path : path.slice(index + 1);
}

function tooLarge(size: number, path: string): Error {
	return new Error(
		`file_too_large (${size} > ${APPLY_PATCH_MAX_FILE_SIZE}) at ${path}; use another tool suitable for large-file edits.`,
	);
}

function lineCount(content: Uint8Array | string | undefined): number {
	if (content === undefined || content.length === 0) return 0;
	const text = typeof content === "string" ? content : new TextDecoder().decode(content);
	const lines = text.split(/\r\n|\n|\r/);
	return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function plannedDelta(
	operation: V4aPatchOperation,
	content: Uint8Array | undefined,
): { readonly addedLines: number; readonly removedLines: number } {
	if (operation.kind === "add")
		return { addedLines: lineCount(operation.content), removedLines: 0 };
	if (operation.kind === "delete") return { addedLines: 0, removedLines: lineCount(content) };
	return {
		addedLines: operation.hunks.reduce(
			(total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length,
			0,
		),
		removedLines: operation.hunks.reduce(
			(total, hunk) => total + hunk.lines.filter((line) => line.kind === "remove").length,
			0,
		),
	};
}

function appliedDelta(
	operation: V4aPatchOperation,
	outcomes: readonly Extract<MpatchHunkOutcome, { readonly kind: "applied" }>[],
): { readonly addedLines: number; readonly removedLines: number } {
	if (operation.kind !== "update") return plannedDelta(operation, undefined);
	return outcomes.reduce(
		(total, outcome) => {
			const hunk = operation.hunks[outcome.hunkIndex - 1];
			if (hunk === undefined) return total;
			return {
				addedLines: total.addedLines + hunk.lines.filter((line) => line.kind === "add").length,
				removedLines:
					total.removedLines + hunk.lines.filter((line) => line.kind === "remove").length,
			};
		},
		{ addedLines: 0, removedLines: 0 },
	);
}

function progressScore(outcome: ApplyPatchAppliedOperation): number | undefined {
	const scores = outcome.outcomes.flatMap((hunk) =>
		hunk.match === "fuzzy" && hunk.score !== undefined ? [hunk.score] : [],
	);
	return scores.length === 0 ? undefined : Math.min(...scores);
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

function rejectedOutcomes(
	outcomes: readonly MpatchHunkOutcome[],
): readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[] {
	return outcomes.filter(
		(outcome): outcome is Exclude<MpatchHunkOutcome, { readonly kind: "applied" }> =>
			outcome.kind !== "applied",
	);
}

function appliedOutcomes(
	outcomes: readonly MpatchHunkOutcome[],
): readonly Extract<MpatchHunkOutcome, { readonly kind: "applied" }>[] {
	return outcomes.filter(
		(outcome): outcome is Extract<MpatchHunkOutcome, { readonly kind: "applied" }> =>
			outcome.kind === "applied",
	);
}

interface MpatchAttempt {
	readonly applied: boolean;
	readonly result: MpatchRunResult;
	readonly before: Uint8Array;
	readonly after?: Uint8Array;
}

async function checkedMpatch(
	cwd: string,
	operation: V4aUpdateOperation,
	fuzzFactor: number,
	signal?: AbortSignal,
): Promise<MpatchAttempt> {
	const source = join(cwd, ...operation.path.split("/"));
	const beforeApply = await readFile(source, signal === undefined ? undefined : { signal });
	const result = await runMpatch({
		cwd,
		unifiedDiff: compileV4aUpdateToUnifiedDiff(operation),
		fuzzFactor,
		dryRun: false,
		...(signal === undefined ? {} : { signal }),
	});
	if (result.status !== 0) {
		await writeFile(source, beforeApply, signal === undefined ? undefined : { signal });
		return { applied: false, result, before: beforeApply };
	}
	return { applied: true, result, before: beforeApply, after: await readFile(source) };
}

async function stageUpdate(
	stagingRoot: string,
	operation: V4aUpdateOperation,
	policy: FuzzyApplyPatchPolicy,
	signal?: AbortSignal,
): Promise<StageUpdateResult> {
	const outcomes: Extract<MpatchHunkOutcome, { readonly kind: "applied" }>[] = [];
	const rejected: Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[] = [];
	const snapshots: ApplyPatchHunkSnapshot[] = [];
	let mode: "exact" | "fuzzy" | undefined;
	let after: Uint8Array = await readFile(join(stagingRoot, ...operation.path.split("/")));
	for (const [index, hunk] of operation.hunks.entries()) {
		const hunkIndex = index + 1;
		const atomicOperation: V4aUpdateOperation = {
			kind: "update",
			path: operation.path,
			hunks: [hunk],
		};
		const exact = await checkedMpatch(stagingRoot, atomicOperation, 0, signal);
		let attempt = exact;
		if (!exact.applied && policy.minSimilarity !== 0)
			attempt = await checkedMpatch(stagingRoot, atomicOperation, policy.minSimilarity, signal);
		if (!attempt.applied) {
			rejected.push(
				...rejectedOutcomes(attempt.result.outcomes).map((outcome) => ({
					...outcome,
					hunkIndex,
				})),
			);
			continue;
		}
		const applied = appliedOutcomes(attempt.result.outcomes);
		outcomes.push(...applied.map((outcome) => ({ ...outcome, hunkIndex })));
		if (attempt.after !== undefined) {
			after = attempt.after;
			for (const outcome of applied)
				snapshots.push(
					snapshotHunk(
						operation.moveTo ?? operation.path,
						hunkIndex,
						outcome,
						hunk,
						attempt.before,
						attempt.after,
					),
				);
		}
		if (
			attempt.result.outcomes.some(
				(outcome) => outcome.kind === "applied" && outcome.match === "fuzzy",
			)
		)
			mode = "fuzzy";
		else mode ??= "exact";
	}
	return { mode, outcomes, rejected, snapshots: Object.freeze(snapshots), after };
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
	if (followed.size > APPLY_PATCH_MAX_FILE_SIZE) throw tooLarge(followed.size, operation.path);
	const before = await fs.readFollow(operation.path, signal, sftpTimeoutMs(followed.size));
	if (before.length > APPLY_PATCH_MAX_FILE_SIZE) throw tooLarge(before.length, operation.path);
	const stagingRoot = join(tmpdir(), `hepi-apply-patch-${randomUUID()}`);
	await mkdir(stagingRoot);
	const stagedFile = join(stagingRoot, ...operation.path.split("/"));
	await mkdir(dirname(stagedFile), { recursive: true });
	await writeFile(
		stagedFile,
		before,
		followed.mode === undefined ? undefined : { mode: followed.mode },
	);
	try {
		const stage = await stageUpdate(stagingRoot, operation, policy, signal);
		if (stage.rejected.length > 0)
			throw new PatchUpdateError("One or more update hunks failed", stage.rejected);
		if (stage.after.length > APPLY_PATCH_MAX_FILE_SIZE)
			throw tooLarge(stage.after.length, operation.moveTo ?? operation.path);
		return { bytes: stage.after, before, mode: followed.mode, stage };
	} finally {
		await rm(stagingRoot, { recursive: true, force: true });
	}
}

async function publishFile(
	fs: PatchFs,
	path: string,
	data: Uint8Array,
	mode: number | undefined,
	replaceExisting: boolean,
	signal?: AbortSignal,
): Promise<void> {
	const directory = parentDir(path);
	if (directory !== ".") await fs.mkdirp(directory, signal);
	const temp = `${directory === "." ? "" : `${directory}/`}${agentPatchTempName(baseName(path))}`;
	try {
		await fs.writeAtomic(temp, data, mode, signal);
		if (replaceExisting) await fs.replace(temp, path, signal);
		else await fs.renameNew(temp, path, signal);
	} catch (error) {
		if (!(error instanceof FsTransportError) || error.phase === "write")
			await fs.unlink(temp, signal).catch(() => undefined);
		throw error;
	}
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
	if (bytes.length > APPLY_PATCH_MAX_FILE_SIZE) throw tooLarge(bytes.length, operation.path);
	await publishFile(fs, operation.path, bytes, undefined, false, signal);
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
		throw tooLarge(meta.size, operation.path);
	const before =
		meta.kind === "file"
			? await fs.readFollow(operation.path, signal, sftpTimeoutMs(meta.size))
			: undefined;
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
	await publishFile(
		fs,
		dest,
		prepared.bytes,
		prepared.mode,
		operation.moveTo === undefined,
		signal,
	);
	const destPaths = operation.moveTo === undefined ? [operation.path] : [operation.moveTo];
	const outcome = Object.freeze({
		operationIndex: index,
		kind: "update" as const,
		paths: Object.freeze(destPaths),
		outcomes: Object.freeze([...prepared.stage.outcomes]),
		snapshots: Object.freeze([...prepared.stage.snapshots]),
	});
	if (operation.moveTo === undefined) return { outcome, mode: prepared.stage.mode };
	try {
		await fs.unlink(operation.path, signal);
		return {
			outcome: Object.freeze({
				...outcome,
				paths: Object.freeze([operation.path, operation.moveTo]),
			}),
			mode: prepared.stage.mode,
		};
	} catch (sourceError) {
		return {
			outcome,
			mode: prepared.stage.mode,
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
		patchOutcome?: ApplyPatchAppliedOperation,
	): void => {
		const current = progressOperations[index];
		if (current === undefined) throw new Error(`Missing patch progress operation: ${index}`);
		const score =
			status === "fuzzy" && patchOutcome !== undefined ? progressScore(patchOutcome) : undefined;
		const { score: _score, ...rest } = current;
		progressOperations[index] = Object.freeze({
			...rest,
			status,
			...(score === undefined ? {} : { score }),
		});
	};
	const emit = (stage: ApplyPatchProgress["stage"]): void => {
		const counted = progressOperations.filter(
			(operation) => operation.status === "applied" || operation.status === "fuzzy",
		);
		options.onProgress?.(
			Object.freeze({
				stage,
				files: new Set(progressOperations.map((operation) => operation.path)).size,
				addedLines: counted.reduce((total, operation) => total + operation.addedLines, 0),
				removedLines: counted.reduce((total, operation) => total + operation.removedLines, 0),
				operations: Object.freeze([...progressOperations]),
			}),
		);
	};
	const release = await acquireApplyPatchLock(options.lockKey ?? fs.scope);
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
				setStatus(index, "not_applied");
				notApplied.push(rejection(index, operationTouchedPaths(operation), "NotApplied"));
				continue;
			}
			if (options.signal?.aborted) {
				if (applied.length === 0 && unconfirmed.length === 0)
					throw options.signal.reason ?? new Error("aborted");
				halt = "not_applied";
				setStatus(index, "not_applied");
				notApplied.push(rejection(index, operationTouchedPaths(operation), "NotApplied"));
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
					if (published.sourceError !== undefined) {
						if (published.sourceUnknown === true) {
							unconfirmed.push(rejection(index, [operation.path], published.sourceError));
							setStatus(index, "unconfirmed", published.outcome);
							halt = "unconfirmed";
						} else {
							rejected.push(rejection(index, [operation.path], published.sourceError));
							setStatus(index, "rejected", published.outcome);
						}
					} else {
						const current = progressOperations[index];
						if (current !== undefined) {
							const { score: _score, ...rest } = current;
							const score = progressScore(published.outcome);
							progressOperations[index] = Object.freeze({
								...rest,
								...appliedDelta(operation, published.outcome.outcomes),
								status: (published.mode === "fuzzy" ? "fuzzy" : "applied") as "fuzzy" | "applied",
								...(score === undefined ? {} : { score }),
							});
						}
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
				setStatus(index, "not_applied");
				notApplied.push(rejection(index, operationTouchedPaths(operation), "NotApplied"));
			}
		}
		emit("done");
		const counted = progressOperations.filter(
			(operation) => operation.status === "applied" || operation.status === "fuzzy",
		);
		return Object.freeze({
			changedPaths: Object.freeze([
				...new Set(applied.flatMap((operation) => [...operation.paths])),
			]),
			addedLines: counted.reduce((total, operation) => total + operation.addedLines, 0),
			removedLines: counted.reduce((total, operation) => total + operation.removedLines, 0),
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
