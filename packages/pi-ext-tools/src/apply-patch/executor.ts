import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
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

const UNSUPPORTED_COMMIT_PLATFORM =
	"apply_patch commit requires Linux descriptor-relative workspace protection";
const UNSUPPORTED_TOOL_PLATFORM_GUIDANCE =
	"apply_patch requires Linux descriptor-relative workspace protection; select Edit Mode: native and reload";

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
	readonly snapshots: readonly ApplyPatchHunkSnapshot[];
}

class PatchUpdateError extends Error {
	constructor(
		message: string,
		readonly diagnostics: readonly Exclude<MpatchHunkOutcome, { readonly kind: "applied" }>[],
	) {
		super(message);
	}
}

interface WorkspacePath {
	readonly relativePath: string;
	readonly absolutePath: string;
}

interface WorkspaceRoot {
	readonly absolutePath: string;
	readonly handle: FileHandle;
	readonly dev: number;
	readonly ino: number;
	[Symbol.asyncDispose](): Promise<void>;
}

interface FileIdentity {
	readonly hash: string;
	readonly mode: number;
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}

interface PathState extends WorkspacePath {
	readonly baseline: FileIdentity | undefined;
	readonly currentHash: string | undefined;
	readonly mode?: number;
	readonly content?: Buffer;
}

interface WorkspaceSnapshot {
	readonly identity?: FileIdentity;
	readonly content?: Buffer;
}

function isMissingPath(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function fileIdentity(info: Stats, content: Buffer): FileIdentity {
	return {
		hash: createHash("sha256").update(content).digest("hex"),
		mode: info.mode & 0o7777,
		dev: info.dev,
		ino: info.ino,
		size: info.size,
		mtimeMs: info.mtimeMs,
		ctimeMs: info.ctimeMs,
	};
}

function sameFileIdentity(
	actual: FileIdentity | undefined,
	expected: FileIdentity | undefined,
): boolean {
	return (
		actual?.hash === expected?.hash &&
		actual?.mode === expected?.mode &&
		actual?.dev === expected?.dev &&
		actual?.ino === expected?.ino &&
		actual?.size === expected?.size &&
		actual?.mtimeMs === expected?.mtimeMs &&
		actual?.ctimeMs === expected?.ctimeMs
	);
}

function stagingPath(stagingRoot: string, relativePath: string): string {
	return join(stagingRoot, ...relativePath.split("/"));
}

async function ensureParent(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
}

async function assertBaselines(
	workspace: WorkspaceRoot,
	states: ReadonlyMap<string, PathState>,
	signal?: AbortSignal,
): Promise<void> {
	for (const state of states.values()) {
		signal?.throwIfAborted();
		await assertSafeCommitPath(workspace, state);
		const snapshot = await snapshotWorkspacePath(workspace, state, signal);
		if (!sameFileIdentity(snapshot.identity, state.baseline))
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
		return {
			...state,
			currentHash: hashContent(content),
			content,
		};
	} catch (error) {
		if (!isMissingPath(error)) throw error;
		return {
			relativePath: state.relativePath,
			absolutePath: state.absolutePath,
			baseline: state.baseline,
			currentHash: undefined,
			...(state.mode === undefined ? {} : { mode: state.mode }),
		};
	}
}

interface MpatchAttempt {
	readonly applied: boolean;
	readonly result: MpatchRunResult;
	readonly before: Buffer;
	readonly after?: Buffer;
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
	if (result.status !== 0) {
		await writeFile(source, beforeApply, { signal });
		return { applied: false, result, before: beforeApply };
	}
	const afterApply = await readFile(source, { signal });
	return { applied: true, result, before: beforeApply, after: afterApply };
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
	const recordApplied = (
		attempt: MpatchAttempt,
		hunkIndex: number,
		hunk: V4aUpdateOperation["hunks"][number],
	): void => {
		const applied = appliedOutcomes(attempt.result.outcomes);
		outcomes.push(...applied.map((outcome) => reindexAppliedOutcome(outcome, hunkIndex)));
		if (attempt.after !== undefined) {
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
	};
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
			recordApplied(exact, hunkIndex, hunk);
			mode ??= "exact";
			continue;
		}
		if (policy.minSimilarity !== 0) {
			const fuzzy = await checkedMpatch(stagingRoot, atomicOperation, policy.minSimilarity, signal);
			if (fuzzy.applied) {
				recordApplied(fuzzy, hunkIndex, hunk);
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
	return { mode, outcomes, rejected, snapshots: Object.freeze(snapshots) };
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

function snapshotHunk(
	path: string,
	hunkIndex: number,
	outcome: Extract<MpatchHunkOutcome, { readonly kind: "applied" }>,
	hunk: V4aUpdateOperation["hunks"][number],
	before: Buffer,
	after: Buffer,
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
			? stageResult.snapshots
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
	readonly before: WorkspaceSnapshot;
}

async function snapshotCommitJournal(
	workspace: WorkspaceRoot,
	states: readonly PathState[],
	signal?: AbortSignal,
): Promise<readonly CommitJournalEntry[]> {
	const journal: CommitJournalEntry[] = [];
	for (const state of states)
		journal.push({ state, before: await snapshotWorkspacePath(workspace, state, signal) });
	return Object.freeze(journal);
}

interface CommitParent {
	readonly handle: FileHandle;
	readonly path: string;
}

const COMMIT_DIRECTORY_FLAGS =
	fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

interface CreatedDirectory extends WorkspacePath {
	readonly dev: number;
	readonly ino: number;
}

async function openWorkspaceRoot(workspaceRoot: string): Promise<WorkspaceRoot> {
	if (process.platform !== "linux") throw new Error(UNSUPPORTED_COMMIT_PLATFORM);
	const requestedPath = await realpath(workspaceRoot);
	const handle = await open(requestedPath, COMMIT_DIRECTORY_FLAGS);
	try {
		const info = await handle.stat();
		return {
			absolutePath: await realpath(`/proc/self/fd/${handle.fd}`),
			handle,
			dev: info.dev,
			ino: info.ino,
			[Symbol.asyncDispose]: async (): Promise<void> => {
				await handle.close();
			},
		};
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function openCommitParent(
	workspace: WorkspaceRoot,
	state: WorkspacePath,
	createMissing: boolean,
	createdDirectories?: CreatedDirectory[],
): Promise<CommitParent | undefined> {
	const parent = dirname(state.absolutePath);
	const parentRelative = relative(workspace.absolutePath, parent);
	if (parentRelative === ".." || parentRelative.startsWith(`..${sep}`))
		throw new Error(`Patch parent escapes workspace root: ${state.relativePath}`);
	let handle = await open(
		`/proc/self/fd/${workspace.handle.fd}`,
		COMMIT_DIRECTORY_FLAGS & ~fsConstants.O_NOFOLLOW,
	);
	let logicalParent = workspace.absolutePath;
	try {
		for (const segment of parentRelative.split(sep).filter(Boolean)) {
			const child = join(`/proc/self/fd/${handle.fd}`, segment);
			logicalParent = join(logicalParent, segment);
			let next: FileHandle;
			try {
				next = await open(child, COMMIT_DIRECTORY_FLAGS);
			} catch (error) {
				if (!isMissingPath(error) || !createMissing) {
					if (!createMissing && isMissingPath(error)) {
						await handle.close();
						return undefined;
					}
					throw error;
				}
				await mkdir(child);
				try {
					next = await open(child, COMMIT_DIRECTORY_FLAGS);
				} catch (openError) {
					try {
						await rmdir(child);
					} catch (cleanupError) {
						throw new Error(
							`workspace state indeterminate after creating patch parent ${relative(workspace.absolutePath, logicalParent).split(sep).join("/")}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
							{ cause: openError },
						);
					}
					throw openError;
				}
				const info = await next.stat();
				createdDirectories?.push({
					relativePath: relative(workspace.absolutePath, logicalParent).split(sep).join("/"),
					absolutePath: logicalParent,
					dev: info.dev,
					ino: info.ino,
				});
			}
			await handle.close();
			handle = next;
		}
		return { handle, path: `/proc/self/fd/${handle.fd}` };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function assertWorkspaceRootPath(workspace: WorkspaceRoot): Promise<void> {
	let handle: FileHandle;
	try {
		handle = await open(workspace.absolutePath, COMMIT_DIRECTORY_FLAGS);
	} catch (error) {
		throw new Error("Patch workspace root changed before commit", { cause: error });
	}
	try {
		const info = await handle.stat();
		if (info.dev !== workspace.dev || info.ino !== workspace.ino)
			throw new Error("Patch workspace root changed before commit");
	} finally {
		await handle.close();
	}
}

async function assertSafeCommitPath(workspace: WorkspaceRoot, state: WorkspacePath): Promise<void> {
	await assertWorkspaceRootPath(workspace);
	if (join(workspace.absolutePath, ...state.relativePath.split("/")) !== state.absolutePath)
		throw new Error(`Patch path changed before commit: ${state.relativePath}`);
}

const TARGET_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const TEMPORARY_WRITE_FLAGS =
	fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

async function temporaryPathOwnership(
	path: string,
	handle: FileHandle,
): Promise<"missing" | "owned" | "replaced"> {
	try {
		const [pathInfo, handleInfo] = await Promise.all([lstat(path), handle.stat()]);
		return pathInfo.dev === handleInfo.dev && pathInfo.ino === handleInfo.ino
			? "owned"
			: "replaced";
	} catch (error) {
		if (isMissingPath(error)) return "missing";
		throw error;
	}
}

async function failedTemporaryInstall(
	path: string,
	handle: FileHandle,
	relativePath: string,
	cause: unknown,
): Promise<never> {
	const ownership = await temporaryPathOwnership(path, handle);
	if (ownership === "missing") throw cause;
	throw new Error(
		`workspace state indeterminate after failed install for ${relativePath}; ${ownership} temporary entry ${basename(path)} remains for inspection`,
		{ cause },
	);
}

async function snapshotFixedTarget(
	parent: CommitParent,
	state: WorkspacePath,
	signal?: AbortSignal,
): Promise<WorkspaceSnapshot> {
	const target = join(parent.path, basename(state.absolutePath));
	let handle: FileHandle;
	try {
		handle = await open(target, TARGET_READ_FLAGS);
	} catch (error) {
		if (isMissingPath(error)) return {};
		throw error;
	}
	try {
		const before = await handle.stat();
		if (!before.isFile())
			throw new Error(`Patch path is not a regular file: ${state.relativePath}`);
		const content = await handle.readFile({ signal });
		const after = await handle.stat();
		const beforeIdentity = fileIdentity(before, content);
		const afterIdentity = fileIdentity(after, content);
		if (!sameFileIdentity(beforeIdentity, afterIdentity))
			throw new Error(`Patch path changed while reading: ${state.relativePath}`);
		return { identity: afterIdentity, content };
	} finally {
		await handle.close();
	}
}

async function snapshotWorkspacePath(
	workspace: WorkspaceRoot,
	state: WorkspacePath,
	signal?: AbortSignal,
): Promise<WorkspaceSnapshot> {
	await assertSafeCommitPath(workspace, state);
	const parent = await openCommitParent(workspace, state, false);
	if (parent === undefined) return {};
	try {
		return await snapshotFixedTarget(parent, state, signal);
	} finally {
		await parent.handle.close();
	}
}

async function writeExclusiveTemporary(
	parent: CommitParent,
	prefix: string,
	affectedPath: string,
	content: Buffer,
	mode: number,
): Promise<{ readonly path: string; readonly handle: FileHandle; readonly content: Buffer }> {
	const path = join(parent.path, `.${prefix}-${process.pid}-${randomUUID()}`);
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, TEMPORARY_WRITE_FLAGS, mode);
		await handle.writeFile(content);
		await handle.chmod(mode);
		return { path, handle, content };
	} catch (error) {
		if (handle !== undefined) {
			try {
				await failedTemporaryInstall(path, handle, affectedPath, error);
			} finally {
				await handle.close().catch(() => undefined);
			}
		}
		throw error;
	}
}

async function removeCreatedDirectories(
	workspace: WorkspaceRoot,
	createdDirectories: readonly CreatedDirectory[],
): Promise<readonly string[]> {
	const failures: string[] = [];
	for (const directory of [...createdDirectories].reverse()) {
		try {
			const parent = await openCommitParent(workspace, directory, false);
			if (parent === undefined) continue;
			try {
				const target = join(parent.path, basename(directory.absolutePath));
				let handle: FileHandle;
				try {
					handle = await open(target, COMMIT_DIRECTORY_FLAGS);
				} catch (error) {
					if (isMissingPath(error)) continue;
					throw error;
				}
				try {
					const info = await handle.stat();
					if (info.dev !== directory.dev || info.ino !== directory.ino)
						throw new Error(`created directory changed externally: ${directory.relativePath}`);
				} finally {
					await handle.close();
				}
				await rmdir(target);
			} finally {
				await parent.handle.close();
			}
		} catch (error) {
			failures.push(
				`${directory.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return Object.freeze(failures);
}

async function restoreCommitJournal(
	workspace: WorkspaceRoot,
	journal: readonly CommitJournalEntry[],
	expected: ReadonlyMap<string, FileIdentity | undefined>,
	createdDirectories: readonly CreatedDirectory[],
): Promise<void> {
	const failures: string[] = [];
	for (const entry of [...journal].reverse()) {
		try {
			const parent = await openCommitParent(
				workspace,
				entry.state,
				entry.before.content !== undefined,
			);
			if (parent === undefined) continue;
			try {
				const actual = await snapshotFixedTarget(parent, entry.state);
				if (!sameFileIdentity(actual.identity, expected.get(entry.state.relativePath)))
					throw new Error(`rollback target changed externally: ${entry.state.relativePath}`);
				if (sameFileIdentity(actual.identity, entry.before.identity)) continue;
				const target = join(parent.path, basename(entry.state.absolutePath));
				if (entry.before.content === undefined) {
					await unlink(target).catch((error: unknown) => {
						if (!isMissingPath(error)) throw error;
					});
					continue;
				}
				const temporary = await writeExclusiveTemporary(
					parent,
					"hepi-apply-patch-rollback",
					entry.state.relativePath,
					entry.before.content,
					entry.before.identity?.mode ?? 0o644,
				);
				let installed = false;
				try {
					await rename(temporary.path, target);
					installed = true;
					const expectedIdentity = fileIdentity(await temporary.handle.stat(), temporary.content);
					const restored = await snapshotFixedTarget(parent, entry.state);
					if (!sameFileIdentity(restored.identity, expectedIdentity))
						throw new Error(`rollback target changed during install: ${entry.state.relativePath}`);
				} catch (error) {
					if (!installed)
						await failedTemporaryInstall(
							temporary.path,
							temporary.handle,
							entry.state.relativePath,
							error,
						);
					throw error;
				} finally {
					await temporary.handle.close().catch(() => undefined);
				}
			} finally {
				await parent.handle.close();
			}
		} catch (error) {
			failures.push(
				`${entry.state.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	failures.push(...(await removeCreatedDirectories(workspace, createdDirectories)));
	if (failures.length > 0)
		throw new Error(`rollback failed for ${failures.length} path(s): ${failures.join("; ")}`);
}

async function commitPath(
	workspace: WorkspaceRoot,
	stagingRoot: string,
	state: PathState,
	expected: FileIdentity | undefined,
	createdDirectories: CreatedDirectory[],
	signal?: AbortSignal,
): Promise<FileIdentity | undefined> {
	signal?.throwIfAborted();
	await assertSafeCommitPath(workspace, state);
	const source = stagingPath(stagingRoot, state.relativePath);
	let sourceInfo: Stats;
	try {
		sourceInfo = await stat(source);
	} catch (error) {
		if (!isMissingPath(error)) throw error;
		const parent = await openCommitParent(workspace, state, false);
		if (parent === undefined) {
			if (expected !== undefined)
				throw new Error(`Patch baseline changed during commit: ${state.relativePath}`);
			return undefined;
		}
		try {
			const actual = await snapshotFixedTarget(parent, state, signal);
			if (!sameFileIdentity(actual.identity, expected))
				throw new Error(`Patch baseline changed during commit: ${state.relativePath}`);
			await unlink(join(parent.path, basename(state.absolutePath))).catch((error: unknown) => {
				if (!isMissingPath(error)) throw error;
			});
		} finally {
			await parent.handle.close();
		}
		return undefined;
	}
	if (!sourceInfo.isFile())
		throw new Error(`Patch staging path is not a regular file: ${state.relativePath}`);
	const sourceContent = await readFile(source, { signal });
	const parent = await openCommitParent(workspace, state, true, createdDirectories);
	if (parent === undefined) throw new Error(`Patch parent is unavailable: ${state.relativePath}`);
	try {
		const actual = await snapshotFixedTarget(parent, state, signal);
		if (!sameFileIdentity(actual.identity, expected))
			throw new Error(`Patch baseline changed during commit: ${state.relativePath}`);
		const target = join(parent.path, basename(state.absolutePath));
		const temporary = await writeExclusiveTemporary(
			parent,
			"hepi-apply-patch",
			state.relativePath,
			sourceContent,
			state.mode ?? sourceInfo.mode & 0o7777,
		);
		let installed = false;
		try {
			const beforeRename = await snapshotFixedTarget(parent, state, signal);
			if (!sameFileIdentity(beforeRename.identity, expected))
				throw new Error(`Patch baseline changed during commit: ${state.relativePath}`);
			await rename(temporary.path, target);
			installed = true;
			const expectedIdentity = fileIdentity(await temporary.handle.stat(), temporary.content);
			const installedTarget = await snapshotFixedTarget(parent, state);
			if (!sameFileIdentity(installedTarget.identity, expectedIdentity))
				throw new Error(`Patch target changed during install: ${state.relativePath}`);
			return expectedIdentity;
		} catch (error) {
			if (!installed)
				await failedTemporaryInstall(temporary.path, temporary.handle, state.relativePath, error);
			throw error;
		} finally {
			await temporary.handle.close().catch(() => undefined);
		}
	} finally {
		await parent.handle.close();
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
	if (process.platform !== "linux") throw new Error(UNSUPPORTED_TOOL_PLATFORM_GUIDANCE);
	await using workspace = await openWorkspaceRoot(options.workspaceRoot);
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
				const validated = await validatePatchPath(workspace.absolutePath, relativePath);
				const path: WorkspacePath = {
					relativePath,
					absolutePath: validated.absolutePath,
				};
				const snapshot = await snapshotWorkspacePath(workspace, path, options.signal);
				states.set(relativePath, {
					...path,
					baseline: snapshot.identity,
					currentHash: snapshot.identity?.hash,
					...(snapshot.content === undefined ? {} : { content: snapshot.content }),
					...(snapshot.identity === undefined ? {} : { mode: snapshot.identity.mode }),
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
					if (state.mode !== undefined) await chmod(staged, state.mode);
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
				await assertBaselines(workspace, touched, options.signal);
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
		const commitExpected = new Map<string, FileIdentity | undefined>();
		for (const state of commitStates.values())
			commitExpected.set(state.relativePath, state.baseline);
		const journal = await snapshotCommitJournal(
			workspace,
			[...commitStates.values()],
			options.signal,
		);
		await assertBaselines(workspace, commitStates, options.signal);
		const committed: ApplyPatchAppliedOperation[] = [];
		const createdDirectories: CreatedDirectory[] = [];
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
					const committedIdentity = await commitPath(
						workspace,
						stagingRoot,
						state,
						state.baseline,
						createdDirectories,
						options.signal,
					);
					states.set(path, { ...state, baseline: committedIdentity });
					commitExpected.set(path, committedIdentity);
					await assertWorkspaceRootPath(workspace);
					options.signal?.throwIfAborted();
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
				await new Promise<void>((resolve) => setImmediate(resolve));
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
				await restoreCommitJournal(workspace, journal, commitExpected, createdDirectories);
				emitProgress("rolled_back");
			} catch (rollbackError) {
				throw new Error(
					`workspace state indeterminate after commit failure; read ${[...commitStates.keys()].join(", ")}: ${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				);
			}
			if (error instanceof Error && error.message.includes("workspace state indeterminate"))
				throw error;
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
