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
import { runJsDiffUpdate } from "./jsdiff.js";
import { acquireMutationLock } from "./lock.js";
import type {
	ApplyPatchAppliedOperation,
	ApplyPatchHunkSnapshot,
	ApplyPatchInWorkspaceResult,
	ApplyPatchOperationProgress,
	ApplyPatchProgress,
	ApplyPatchRejection,
	PreparedPatchUpdate,
	RejectedPatchHunk,
} from "./outcome.js";
import {
	findV4aPatchConflicts,
	operationTouchedPaths,
	parseV4aPatch,
	type V4aPatch,
	type V4aPatchOperation,
	type V4aUpdateOperation,
} from "./parser.js";
import { assertPatchPath } from "./paths.js";
import type { ApplyPatchPolicy } from "./policy.js";

const SNAPSHOT_MAX_LINES = 150;

export interface ApplyPatchInWorkspaceOptions {
	readonly workspaceRoot: string;
	readonly patch: string;
	readonly parsedPatch?: V4aPatch;
	readonly policy: ApplyPatchPolicy;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: ApplyPatchProgress) => void;
	readonly fs?: PatchFs;
	readonly lockKey?: string;
}

class PatchUpdateError extends Error {
	constructor(
		message: string,
		readonly diagnostics: readonly RejectedPatchHunk[],
	) {
		super(message);
	}
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
	diagnostics: readonly RejectedPatchHunk[] = [],
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
	policy: ApplyPatchPolicy,
	signal?: AbortSignal,
): Promise<{
	readonly bytes: Uint8Array;
	readonly before: Uint8Array;
	readonly mode: number | undefined;
	readonly stage: PreparedPatchUpdate;
}> {
	const followed = await fs.statFollow(operation.path, signal);
	if (followed.kind === "missing")
		throw new Error(`Patch source does not exist: ${operation.path}`);
	if (followed.kind !== "file")
		throw new Error(`Patch path is not a regular file: ${operation.path}`);
	if (followed.size > APPLY_PATCH_MAX_FILE_SIZE) throw fileTooLarge(followed.size, operation.path);
	const before = await fs.readFollow(operation.path, signal, sftpTimeoutMs(followed.size));
	if (before.length > APPLY_PATCH_MAX_FILE_SIZE) throw fileTooLarge(before.length, operation.path);
	const stage = await runJsDiffUpdate({
		before,
		operation,
		fuzzFactor: policy.fuzzFactor,
		...(signal === undefined ? {} : { signal }),
	});
	if (operation.hunks.length > 0 && stage.outcomes.length === 0)
		throw new PatchUpdateError("One or more update hunks failed", stage.rejected);
	if (stage.after.length > APPLY_PATCH_MAX_FILE_SIZE)
		throw fileTooLarge(stage.after.length, operation.moveTo ?? operation.path);
	return { bytes: stage.after, before, mode: followed.mode, stage };
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
	readonly rejectedHunks: readonly RejectedPatchHunk[];
	readonly prepared: PreparedPatchUpdate;
	readonly sourceError?: unknown;
	readonly sourceUnknown?: boolean;
}

async function applyUpdate(
	fs: PatchFs,
	index: number,
	operation: V4aUpdateOperation,
	policy: ApplyPatchPolicy,
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
		prepared: prepared.stage,
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
		prepared?: PreparedPatchUpdate,
	): void => {
		const current = progressOperations[index];
		if (current === undefined) throw new Error(`Missing patch progress operation: ${index}`);
		progressOperations[index] = Object.freeze({
			...current,
			...(update === undefined
				? {}
				: update.kind !== "update" || prepared === undefined
					? plannedDelta(update, undefined)
					: { addedLines: prepared.addedLines, removedLines: prepared.removedLines }),
			status,
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
				operationTouchedPaths(operation).map((path) => {
					const separator = path.lastIndexOf("/");
					return separator < 0 ? "." : path.slice(0, separator);
				}),
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
						progressOperations[index] = Object.freeze({
							...current,
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
							: published.rejectedHunks[0]?.kind === "context_not_found"
								? "context not found"
								: "exact context is ambiguous";
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
							setStatus(
								index,
								"unconfirmed",
								published.outcome,
								operation,
								undefined,
								published.prepared,
							);
							halt = "unconfirmed";
						} else {
							rejected.push(rejection(index, [operation.path], published.sourceError));
							setStatus(
								index,
								"partial",
								published.outcome,
								operation,
								partialReason ?? String(published.sourceError),
								published.prepared,
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
							published.prepared,
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
