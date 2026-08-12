import { createHash } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { validatePatchPath } from "./paths.js";
import type { FuzzyApplyPatchPolicy } from "./policy.js";

export interface ApplyPatchInWorkspaceOptions {
	readonly workspaceRoot: string;
	readonly patch: string;
	/** A coordinator-validated parse tree; avoids parsing the same patch twice. */
	readonly parsedPatch?: V4aPatch;
	readonly policy: FuzzyApplyPatchPolicy;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: ApplyPatchProgress) => void;
}

interface StageUpdateResult {
	readonly mode: "exact" | "fuzzy" | undefined;
	readonly outcomes: readonly Extract<MpatchHunkOutcome, { readonly kind: "applied" }>[];
	readonly rejected: readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[];
}

class PatchUpdateError extends Error {
	constructor(
		message: string,
		readonly diagnostics: readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[],
	) {
		super(message);
	}
}

interface PathState {
	readonly relativePath: string;
	readonly absolutePath: string;
	readonly baselineHash: string | undefined;
	readonly currentHash: string | undefined;
	readonly content?: Buffer;
}

interface CachedSource {
	readonly mtimeMs: number;
	readonly size: number;
	readonly hash: string;
	readonly content: Buffer;
}

class SourceCache {
	readonly entries = new Map<string, CachedSource>();
	bytes = 0;

	async snapshot(
		path: string,
		cacheMiB: number,
		signal?: AbortSignal,
	): Promise<{ readonly hash: string | undefined; readonly content?: Buffer }> {
		try {
			const info = await stat(path);
			if (!info.isFile()) throw new Error(`Patch path is not a regular file: ${path}`);
			const cached = this.entries.get(path);
			if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
				this.entries.delete(path);
				this.entries.set(path, cached);
				return { hash: cached.hash, content: cached.content };
			}
			const content = await readFile(path, { signal });
			const hash = createHash("sha256").update(content).digest("hex");
			const source: CachedSource = { mtimeMs: info.mtimeMs, size: info.size, hash, content };
			this.store(path, source, cacheMiB * 1024 * 1024);
			return { hash, content };
		} catch (error) {
			if (isMissingPath(error)) return { hash: undefined };
			throw error;
		}
	}

	private store(path: string, source: CachedSource, limit: number): void {
		const previous = this.entries.get(path);
		if (previous !== undefined) {
			this.entries.delete(path);
			this.bytes -= previous.content.byteLength;
		}
		if (source.content.byteLength > limit) return;
		while (this.bytes + source.content.byteLength > limit) {
			const oldest = this.entries.entries().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest[0]);
			this.bytes -= oldest[1].content.byteLength;
		}
		this.entries.set(path, source);
		this.bytes += source.content.byteLength;
	}
}

const sourceCache = new SourceCache();

function isMissingPath(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function regularFileHash(path: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new Error(`Patch path is not a regular file: ${path}`);
		const content = await readFile(path, { signal });
		return createHash("sha256").update(content).digest("hex");
	} catch (error) {
		if (isMissingPath(error)) return undefined;
		throw error;
	}
}

function stagingPath(stagingRoot: string, relativePath: string): string {
	return join(stagingRoot, ...relativePath.split("/"));
}

async function ensureParent(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
}

async function assertBaselines(
	workspaceRoot: string,
	states: ReadonlyMap<string, PathState>,
	signal?: AbortSignal,
): Promise<void> {
	for (const state of states.values()) {
		signal?.throwIfAborted();
		const revalidated = await validatePatchPath(workspaceRoot, state.relativePath);
		if (revalidated.absolutePath !== state.absolutePath)
			throw new Error(`Patch path changed before commit: ${state.relativePath}`);
		if ((await regularFileHash(state.absolutePath, signal)) !== state.baselineHash)
			throw new Error(`Patch baseline changed before commit: ${state.relativePath}`);
	}
}

function hashContent(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

async function stagedPathState(
	stagingRoot: string,
	state: PathState,
	signal?: AbortSignal,
): Promise<PathState> {
	const path = stagingPath(stagingRoot, state.relativePath);
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new Error(`Patch path is not a regular file: ${state.relativePath}`);
		const content = await readFile(path, { signal });
		return { ...state, currentHash: hashContent(content), content };
	} catch (error) {
		if (!isMissingPath(error)) throw error;
		return {
			relativePath: state.relativePath,
			absolutePath: state.absolutePath,
			baselineHash: state.baselineHash,
			currentHash: undefined,
		};
	}
}

interface MpatchAttempt {
	readonly applied: boolean;
	readonly result: MpatchRunResult;
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

function reindexAppliedOutcome(
	outcome: Extract<MpatchHunkOutcome, { readonly kind: "applied" }>,
	hunkIndex: number,
): Extract<MpatchHunkOutcome, { readonly kind: "applied" }> {
	return { ...outcome, hunkIndex };
}

function reindexRejectedOutcome(
	outcome: Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>,
	hunkIndex: number,
): Exclude<MpatchHunkOutcome, { readonly kind: "applied" }> {
	return { ...outcome, hunkIndex };
}

function hunkFailureSummary(
	diagnostics: readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[],
): string | undefined {
	const first = diagnostics[0];
	if (first === undefined) return undefined;
	switch (first.kind) {
		case "context_not_found":
			return "context not found";
		case "ambiguous_exact":
			return "exact context ambiguous";
		case "ambiguous_fuzzy":
			return "fuzzy context ambiguous";
		case "fuzzy_below_threshold":
			return `fuzzy score ${first.best.score.toFixed(2)} < ${first.threshold.toFixed(2)}`;
	}
}

async function checkedMpatch(
	cwd: string,
	operation: V4aUpdateOperation,
	fuzzFactor: number,
	signal?: AbortSignal,
): Promise<MpatchAttempt> {
	const source = stagingPath(cwd, operation.path);
	const beforeApply = await readFile(source, { signal });
	const result = await runMpatch({
		cwd,
		unifiedDiff: compileV4aUpdateToUnifiedDiff(operation),
		fuzzFactor,
		dryRun: false,
		...(signal === undefined ? {} : { signal }),
	});
	if (result.status !== 0) await writeFile(source, beforeApply, { signal });
	return { applied: result.status === 0, result };
}

async function stageUpdate(
	stagingRoot: string,
	operation: V4aUpdateOperation,
	policy: FuzzyApplyPatchPolicy,
	signal?: AbortSignal,
): Promise<StageUpdateResult> {
	const outcomes: Extract<MpatchHunkOutcome, { readonly kind: "applied" }>[] = [];
	const rejected: Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[] = [];
	let mode: "exact" | "fuzzy" | undefined;
	for (const [index, hunk] of operation.hunks.entries()) {
		const hunkIndex = index + 1;
		const atomicOperation: V4aUpdateOperation = {
			kind: "update",
			path: operation.path,
			hunks: [hunk],
		};
		const exact = await checkedMpatch(stagingRoot, atomicOperation, 0, signal);
		if (exact.applied) {
			outcomes.push(
				...appliedOutcomes(exact.result.outcomes).map((outcome) =>
					reindexAppliedOutcome(outcome, hunkIndex),
				),
			);
			mode ??= "exact";
			continue;
		}
		if (policy.minSimilarity !== 0) {
			const fuzzy = await checkedMpatch(stagingRoot, atomicOperation, policy.minSimilarity, signal);
			if (fuzzy.applied) {
				outcomes.push(
					...appliedOutcomes(fuzzy.result.outcomes).map((outcome) =>
						reindexAppliedOutcome(outcome, hunkIndex),
					),
				);
				mode = "fuzzy";
				continue;
			}
			rejected.push(
				...rejectedOutcomes(fuzzy.result.outcomes).map((outcome) =>
					reindexRejectedOutcome(outcome, hunkIndex),
				),
			);
			continue;
		}
		rejected.push(
			...rejectedOutcomes(exact.result.outcomes).map((outcome) =>
				reindexRejectedOutcome(outcome, hunkIndex),
			),
		);
	}
	return { mode, outcomes, rejected };
}

async function stageOperation(
	stagingRoot: string,
	operation: V4aPatchOperation,
	policy: FuzzyApplyPatchPolicy,
	signal?: AbortSignal,
): Promise<StageUpdateResult | undefined> {
	signal?.throwIfAborted();
	if (operation.kind === "add") {
		const target = stagingPath(stagingRoot, operation.path);
		await ensureParent(target);
		await writeFile(target, operation.content, { encoding: "utf8", flag: "wx", signal });
		return undefined;
	}
	if (operation.kind === "delete") {
		await unlink(stagingPath(stagingRoot, operation.path));
		return undefined;
	}
	const result = await stageUpdate(stagingRoot, operation, policy, signal);
	if (operation.moveTo !== undefined && result.outcomes.length > 0) {
		const source = stagingPath(stagingRoot, operation.path);
		const target = stagingPath(stagingRoot, operation.moveTo);
		await ensureParent(target);
		await rename(source, target);
	}
	return result;
}

function lineCount(content: Buffer | string | undefined): number {
	if (content === undefined || content.length === 0) return 0;
	const lines = content.toString().split(/\r\n|\n|\r/);
	return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function plannedDelta(
	operation: V4aPatchOperation,
	content: Buffer | undefined,
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

function splitTextLines(content: Buffer): readonly string[] {
	const lines = content.toString("utf8").split(/\r\n|\n|\r/);
	if (lines.at(-1) === "") lines.pop();
	return Object.freeze(lines);
}

function snapshotUpdateHunks(
	operation: V4aUpdateOperation,
	outcomes: readonly Extract<MpatchHunkOutcome, { readonly kind: "applied" }>[],
	before: Buffer,
	after: Buffer,
): readonly ApplyPatchHunkSnapshot[] {
	const beforeLines = splitTextLines(before);
	const afterLines = splitTextLines(after);
	const snapshots: ApplyPatchHunkSnapshot[] = [];
	for (const outcome of outcomes) {
		const hunk = operation.hunks[outcome.hunkIndex - 1];
		if (hunk === undefined) continue;
		const afterLength = hunk.lines.filter((line) => line.kind !== "remove").length;
		const priorLineDelta = outcomes
			.filter((previous) => previous.hunkIndex < outcome.hunkIndex)
			.reduce((delta, previous) => {
				const prior = operation.hunks[previous.hunkIndex - 1];
				if (prior === undefined) return delta;
				return (
					delta +
					prior.lines.filter((line) => line.kind !== "remove").length -
					prior.lines.filter((line) => line.kind !== "add").length
				);
			}, 0);
		const start = Math.max(0, outcome.startLine - 1 - 3);
		const afterStart = Math.max(0, outcome.startLine - 1 + priorLineDelta - 3);
		const beforeEnd = Math.min(beforeLines.length, outcome.startLine - 1 + outcome.length + 3);
		const afterEnd = Math.min(afterLines.length, afterStart + 3 + afterLength + 3);
		snapshots.push(
			Object.freeze({
				path: operation.moveTo ?? operation.path,
				hunkIndex: outcome.hunkIndex,
				startLine: start + 1,
				afterStartLine: afterStart + 1,
				before: Object.freeze(beforeLines.slice(start, beforeEnd)),
				after: Object.freeze(afterLines.slice(afterStart, afterEnd)),
			}),
		);
	}
	return Object.freeze(snapshots);
}

function operationOutcome(
	operationIndex: number,
	operation: V4aPatchOperation,
	stageResult: StageUpdateResult | undefined,
	before: Buffer | undefined,
	after: Buffer | undefined,
): ApplyPatchAppliedOperation {
	const path = operation.kind === "update" ? (operation.moveTo ?? operation.path) : operation.path;
	const snapshots =
		operation.kind === "update" &&
		stageResult !== undefined &&
		before !== undefined &&
		after !== undefined
			? snapshotUpdateHunks(operation, stageResult.outcomes, before, after)
			: before === undefined && after === undefined
				? []
				: [
						Object.freeze({
							path,
							hunkIndex: 1,
							startLine: 1,
							afterStartLine: 1,
							before: Object.freeze(before === undefined ? [] : splitTextLines(before)),
							after: Object.freeze(after === undefined ? [] : splitTextLines(after)),
						}),
					];
	return Object.freeze({
		operationIndex,
		kind: operation.kind,
		paths: Object.freeze([...operationTouchedPaths(operation)]),
		outcomes: Object.freeze(stageResult?.outcomes ?? []),
		snapshots: Object.freeze(snapshots),
	});
}

interface CommitJournalEntry {
	readonly state: PathState;
	readonly before?: Buffer;
}

async function snapshotCommitJournal(
	states: readonly PathState[],
): Promise<readonly CommitJournalEntry[]> {
	const journal: CommitJournalEntry[] = [];
	for (const state of states) {
		try {
			const info = await stat(state.absolutePath);
			if (!info.isFile())
				throw new Error(`Patch path is not a regular file: ${state.relativePath}`);
			journal.push({ state, before: await readFile(state.absolutePath) });
		} catch (error) {
			if (isMissingPath(error)) journal.push({ state });
			else throw error;
		}
	}
	return Object.freeze(journal);
}

async function restoreCommitJournal(journal: readonly CommitJournalEntry[]): Promise<void> {
	const failures: string[] = [];
	for (const entry of [...journal].reverse()) {
		try {
			if (entry.before === undefined) {
				await rm(entry.state.absolutePath, { force: true });
				continue;
			}
			await ensureParent(entry.state.absolutePath);
			const temporary = join(
				dirname(entry.state.absolutePath),
				`.hepi-apply-patch-rollback-${process.pid}-${Date.now()}-${Math.random()}`,
			);
			await writeFile(temporary, entry.before);
			try {
				await rename(temporary, entry.state.absolutePath);
			} finally {
				await rm(temporary, { force: true });
			}
		} catch (error) {
			failures.push(
				`${entry.state.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (failures.length > 0)
		throw new Error(`rollback failed for ${failures.length} path(s): ${failures.join("; ")}`);
}

async function commitPath(
	stagingRoot: string,
	state: PathState,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const source = stagingPath(stagingRoot, state.relativePath);
	try {
		await stat(source);
	} catch (error) {
		if (isMissingPath(error)) {
			await rm(state.absolutePath, { force: true });
			return;
		}
		throw error;
	}
	await ensureParent(state.absolutePath);
	const temporary = join(
		dirname(state.absolutePath),
		`.hepi-apply-patch-${process.pid}-${Date.now()}-${Math.random()}`,
	);
	await copyFile(source, temporary);
	try {
		await rename(temporary, state.absolutePath);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: atomic apply/rollback order is one coordinator transaction.
export async function applyPatchInWorkspace(
	options: ApplyPatchInWorkspaceOptions,
): Promise<ApplyPatchInWorkspaceResult> {
	options.signal?.throwIfAborted();
	const patch = options.parsedPatch ?? parseV4aPatch(options.patch);
	const initial = initialRejections(patch);
	const rejected = initial.rejected;
	const rejectedIndices = initial.indices;
	const states = new Map<string, PathState>();
	const successful: {
		readonly index: number;
		readonly operation: V4aPatchOperation;
		readonly stagingRoot: string;
		readonly mode: "exact" | "fuzzy" | undefined;
		readonly outcome: ApplyPatchAppliedOperation;
		readonly rejectedHunkCount: number;
		readonly partialReason?: string;
	}[] = [];
	let exactUpdateCount = 0;
	let fuzzyUpdateCount = 0;
	const progressOperations: ApplyPatchOperationProgress[] = patch.operations.map(
		(operation, index) => ({
			operationIndex: index,
			kind: operation.kind,
			path: operation.kind === "update" ? (operation.moveTo ?? operation.path) : operation.path,
			...plannedDelta(operation, undefined),
			status: rejectedIndices.has(index) ? "rejected" : "pending",
			...(operation.kind === "update"
				? { appliedHunks: 0, totalHunks: operation.hunks.length }
				: {}),
		}),
	);
	const setProgressStatus = (
		index: number,
		status: ApplyPatchOperationProgress["status"],
		outcome?: ApplyPatchAppliedOperation,
	): void => {
		const current = progressOperations[index];
		if (current === undefined) throw new Error(`Missing patch progress operation: ${index}`);
		const score = status === "fuzzy" && outcome !== undefined ? progressScore(outcome) : undefined;
		progressOperations[index] = Object.freeze({
			...current,
			status,
			...(score === undefined ? {} : { score }),
		});
	};
	const emitProgress = (stage: ApplyPatchProgress["stage"] = "staging"): void => {
		const committed = progressOperations.filter(
			(operation) =>
				operation.status === "applied" ||
				operation.status === "partial" ||
				operation.status === "fuzzy",
		);
		options.onProgress?.(
			Object.freeze({
				stage,
				files: new Set(progressOperations.map((operation) => operation.path)).size,
				addedLines: committed.reduce((total, operation) => total + operation.addedLines, 0),
				removedLines: committed.reduce((total, operation) => total + operation.removedLines, 0),
				operations: Object.freeze([...progressOperations]),
			}),
		);
	};
	const rejectOperation = (index: number, operation: V4aPatchOperation, error: unknown): void => {
		setProgressStatus(index, "rejected");
		rejectedIndices.add(index);
		rejected.push(
			Object.freeze({
				operationIndices: Object.freeze([index]),
				paths: Object.freeze([...operationTouchedPaths(operation)]),
				error: error instanceof Error ? error.message : String(error),
				diagnostics: Object.freeze(error instanceof PatchUpdateError ? [...error.diagnostics] : []),
			}),
		);
	};
	const rejectUpdateHunks = (
		index: number,
		operation: V4aUpdateOperation,
		diagnostics: readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[],
	): void => {
		if (diagnostics.length === 0) return;
		rejected.push(
			Object.freeze({
				operationIndices: Object.freeze([index]),
				paths: Object.freeze([operation.moveTo ?? operation.path]),
				error: "One or more update hunks failed",
				diagnostics: Object.freeze([...diagnostics]),
			}),
		);
	};
	for (const [index, operation] of patch.operations.entries()) {
		options.signal?.throwIfAborted();
		if (rejectedIndices.has(index)) continue;
		try {
			for (const relativePath of operationTouchedPaths(operation)) {
				if (states.has(relativePath)) continue;
				const validated = await validatePatchPath(options.workspaceRoot, relativePath);
				const snapshot = await sourceCache.snapshot(
					validated.absolutePath,
					options.policy.cacheMiB,
					options.signal,
				);
				states.set(relativePath, {
					relativePath,
					absolutePath: validated.absolutePath,
					baselineHash: snapshot.hash,
					currentHash: snapshot.hash,
					...(snapshot.content === undefined ? {} : { content: snapshot.content }),
				});
			}
		} catch (error) {
			if (options.signal?.aborted) throw options.signal.reason ?? error;
			rejectOperation(index, operation, error);
		}
	}
	for (const [index, operation] of patch.operations.entries()) {
		const progress = progressOperations[index];
		if (progress === undefined) throw new Error(`Missing patch progress operation: ${index}`);
		if (operation.kind === "delete")
			progressOperations[index] = Object.freeze({
				...progress,
				...plannedDelta(operation, states.get(operation.path)?.content),
			});
	}
	emitProgress();
	try {
		for (const [index, operation] of patch.operations.entries()) {
			options.signal?.throwIfAborted();
			if (rejectedIndices.has(index)) continue;
			let stagingRoot: string | undefined;
			try {
				const source = states.get(operation.path);
				if (source === undefined)
					throw new Error(`Missing validated patch path: ${operation.path}`);
				if (operation.kind === "add" && source.currentHash !== undefined)
					throw new Error(`Patch add target already exists: ${operation.path}`);
				if (operation.kind !== "add" && source.currentHash === undefined)
					throw new Error(`Patch source does not exist: ${operation.path}`);
				if (operation.kind === "update" && operation.moveTo !== undefined) {
					const destination = states.get(operation.moveTo);
					if (destination === undefined || destination.currentHash !== undefined)
						throw new Error(`Patch move destination already exists: ${operation.moveTo}`);
				}
				const sourceBefore = source.content;
				stagingRoot = await mkdtemp(join(tmpdir(), "hepi-apply-patch-"));
				for (const path of operationTouchedPaths(operation)) {
					const state = states.get(path);
					if (state?.currentHash === undefined) continue;
					if (state.content === undefined)
						throw new Error(`Missing source snapshot for patch path: ${path}`);
					const staged = stagingPath(stagingRoot, path);
					await ensureParent(staged);
					await writeFile(staged, state.content, { signal: options.signal });
				}
				const stageResult = await stageOperation(
					stagingRoot,
					operation,
					options.policy,
					options.signal,
				);
				if (
					operation.kind === "update" &&
					stageResult !== undefined &&
					stageResult.outcomes.length === 0
				) {
					rejectUpdateHunks(index, operation, stageResult.rejected);
					await rm(stagingRoot, { recursive: true, force: true });
					stagingRoot = undefined;
					setProgressStatus(index, "rejected");
					emitProgress();
					continue;
				}
				for (const path of operationTouchedPaths(operation)) {
					const state = states.get(path);
					if (state === undefined) throw new Error(`Missing validated patch path: ${path}`);
					states.set(path, await stagedPathState(stagingRoot, state, options.signal));
				}
				const resultPath =
					operation.kind === "update" ? (operation.moveTo ?? operation.path) : operation.path;
				const after = states.get(resultPath)?.content;
				const outcome = operationOutcome(index, operation, stageResult, sourceBefore, after);
				if (operation.kind === "update" && stageResult !== undefined)
					rejectUpdateHunks(index, operation, stageResult.rejected);
				const mode = stageResult?.mode;
				const partialReason =
					stageResult === undefined ? undefined : hunkFailureSummary(stageResult.rejected);
				if (mode === "exact") exactUpdateCount += 1;
				if (mode === "fuzzy") fuzzyUpdateCount += 1;
				successful.push({
					index,
					operation,
					stagingRoot,
					mode,
					outcome,
					rejectedHunkCount: stageResult?.rejected.length ?? 0,
					...(partialReason === undefined ? {} : { partialReason }),
				});
			} catch (error) {
				if (options.signal?.aborted) throw options.signal.reason ?? error;
				if (stagingRoot !== undefined) await rm(stagingRoot, { recursive: true, force: true });
				rejectOperation(index, operation, error);
				emitProgress();
			}
		}
		for (let index = successful.length - 1; index >= 0; index -= 1) {
			const entry = successful[index];
			if (entry === undefined) continue;
			try {
				const touched = new Map<string, PathState>();
				for (const path of operationTouchedPaths(entry.operation)) {
					const state = states.get(path);
					if (state === undefined) throw new Error(`Missing validated patch path: ${path}`);
					touched.set(path, state);
				}
				await assertBaselines(options.workspaceRoot, touched, options.signal);
			} catch (error) {
				if (options.signal?.aborted) throw options.signal.reason ?? error;
				rejectOperation(entry.index, entry.operation, error);
				if (entry.mode === "exact") exactUpdateCount -= 1;
				if (entry.mode === "fuzzy") fuzzyUpdateCount -= 1;
				await rm(entry.stagingRoot, { recursive: true, force: true });
				successful.splice(index, 1);
				emitProgress();
			}
		}
		const commitStates = new Map<string, PathState>();
		for (const entry of successful)
			for (const path of operationTouchedPaths(entry.operation)) {
				const state = states.get(path);
				if (state === undefined) throw new Error(`Missing validated patch path: ${path}`);
				commitStates.set(path, state);
			}
		const journal = await snapshotCommitJournal([...commitStates.values()]);
		await assertBaselines(options.workspaceRoot, commitStates, options.signal);
		const committed: ApplyPatchAppliedOperation[] = [];
		try {
			for (const {
				index,
				operation,
				stagingRoot,
				outcome,
				rejectedHunkCount,
				partialReason,
			} of successful) {
				for (const path of operationTouchedPaths(operation)) {
					const state = states.get(path);
					if (state === undefined) throw new Error(`Missing patch path: ${path}`);
					await commitPath(stagingRoot, state, options.signal);
				}
				committed.push(outcome);
				const current = progressOperations[index];
				if (current === undefined) throw new Error(`Missing patch progress operation: ${index}`);
				progressOperations[index] = Object.freeze({
					...current,
					...appliedDelta(operation, outcome.outcomes),
				});
				const currentProgress = progressOperations[index];
				if (currentProgress === undefined)
					throw new Error(`Missing patch progress operation: ${index}`);
				progressOperations[index] = Object.freeze({
					...currentProgress,
					...(operation.kind === "update"
						? {
								appliedHunks: outcome.outcomes.length,
								totalHunks: operation.hunks.length,
								...(rejectedHunkCount === 0 ? {} : { partialReason }),
							}
						: {}),
				});
				setProgressStatus(
					index,
					rejectedHunkCount > 0
						? "partial"
						: outcome.outcomes.some((hunk) => hunk.match === "fuzzy")
							? "fuzzy"
							: "applied",
					outcome,
				);
				emitProgress("committed");
			}
		} catch (error) {
			for (const operation of progressOperations) {
				if (
					operation.status === "applied" ||
					operation.status === "partial" ||
					operation.status === "fuzzy"
				)
					progressOperations[operation.operationIndex] = Object.freeze({
						operationIndex: operation.operationIndex,
						kind: operation.kind,
						path: operation.path,
						addedLines: 0,
						removedLines: 0,
						status: "rejected",
					});
			}
			try {
				await restoreCommitJournal(journal);
				emitProgress("rolled_back");
			} catch (rollbackError) {
				throw new Error(
					`workspace state indeterminate after commit failure; read ${[...commitStates.keys()].join(", ")}: ${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				);
			}
			throw new Error(
				`apply patch commit rolled back; no staged operations were applied: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const changed = Object.freeze([...new Set(committed.flatMap((outcome) => outcome.paths))]);
		const committedProgress = progressOperations.filter(
			(operation) =>
				operation.status === "applied" ||
				operation.status === "partial" ||
				operation.status === "fuzzy",
		);
		return Object.freeze({
			changedPaths: changed,
			addedLines: committedProgress.reduce((total, operation) => total + operation.addedLines, 0),
			removedLines: committedProgress.reduce(
				(total, operation) => total + operation.removedLines,
				0,
			),
			operations: Object.freeze([...progressOperations]),
			operationCount: patch.operations.length,
			exactUpdateCount,
			fuzzyUpdateCount,
			applied: Object.freeze(committed),
			rejected: Object.freeze(rejected),
		});
	} finally {
		for (const { stagingRoot } of successful)
			await rm(stagingRoot, { recursive: true, force: true });
	}
}
