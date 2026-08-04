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
import { runMpatch } from "./mpatch.js";
import {
	compileV4aUpdateToUnifiedDiff,
	findV4aPatchConflicts,
	operationTouchedPaths,
	parseV4aPatch,
	type V4aPatchOperation,
	type V4aUpdateOperation,
} from "./parser.js";
import { validatePatchPath } from "./paths.js";
import type { FuzzyApplyPatchPolicy } from "./policy.js";

export interface ApplyPatchInWorkspaceOptions {
	readonly workspaceRoot: string;
	readonly patch: string;
	readonly policy: FuzzyApplyPatchPolicy;
	readonly signal?: AbortSignal;
}

export interface ApplyPatchInWorkspaceResult {
	readonly changedPaths: readonly string[];
	readonly operationCount: number;
	readonly exactUpdateCount: number;
	readonly fuzzyUpdateCount: number;
	readonly rejected: readonly ApplyPatchRejection[];
}

export interface ApplyPatchRejection {
	readonly operationIndices: readonly number[];
	readonly paths: readonly string[];
	readonly error: string;
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
		return { ...state, currentHash: undefined, content: undefined };
	}
}

async function checkedMpatch(
	cwd: string,
	operation: V4aUpdateOperation,
	fuzzFactor: number,
	signal?: AbortSignal,
): Promise<boolean> {
	const unifiedDiff = compileV4aUpdateToUnifiedDiff(operation);
	const dryRun = await runMpatch({
		cwd,
		unifiedDiff,
		fuzzFactor,
		dryRun: true,
		...(signal === undefined ? {} : { signal }),
	});
	if (dryRun.status !== 0) return false;
	const source = stagingPath(cwd, operation.path);
	const beforeApply = await readFile(source, { signal });
	const applied = await runMpatch({
		cwd,
		unifiedDiff,
		fuzzFactor,
		dryRun: false,
		...(signal === undefined ? {} : { signal }),
	});
	if (applied.status !== 0) await writeFile(source, beforeApply, { signal });
	return applied.status === 0;
}

async function stageUpdate(
	stagingRoot: string,
	operation: V4aUpdateOperation,
	policy: FuzzyApplyPatchPolicy,
	signal?: AbortSignal,
): Promise<"exact" | "fuzzy"> {
	if (await checkedMpatch(stagingRoot, operation, 0, signal)) return "exact";
	if (policy.minSimilarity === 0)
		throw new Error(`Patch update failed exactly and fuzzy is disabled: ${operation.path}`);
	if (await checkedMpatch(stagingRoot, operation, policy.minSimilarity, signal)) return "fuzzy";
	throw new Error(`Patch update failed: ${operation.path}`);
}

async function stageOperation(
	stagingRoot: string,
	operation: V4aPatchOperation,
	policy: FuzzyApplyPatchPolicy,
	signal?: AbortSignal,
): Promise<"exact" | "fuzzy" | undefined> {
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
	const mode = await stageUpdate(stagingRoot, operation, policy, signal);
	if (operation.moveTo !== undefined) {
		const source = stagingPath(stagingRoot, operation.path);
		const target = stagingPath(stagingRoot, operation.moveTo);
		await ensureParent(target);
		await rename(source, target);
	}
	return mode;
}

function changedPaths(operations: readonly V4aPatchOperation[]): readonly string[] {
	const paths = new Set<string>();
	for (const operation of operations) {
		paths.add(operation.path);
		if (operation.kind === "update" && operation.moveTo !== undefined) paths.add(operation.moveTo);
	}
	return Object.freeze([...paths]);
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

export async function applyPatchInWorkspace(
	options: ApplyPatchInWorkspaceOptions,
): Promise<ApplyPatchInWorkspaceResult> {
	options.signal?.throwIfAborted();
	const patch = parseV4aPatch(options.patch);
	const rejected: ApplyPatchRejection[] = [];
	const rejectedIndices = new Set<number>();
	for (const conflict of findV4aPatchConflicts(patch)) {
		const indices = Object.freeze([...conflict.operationIndices]);
		for (const index of indices) rejectedIndices.add(index);
		rejected.push(
			Object.freeze({
				operationIndices: indices,
				paths: Object.freeze([conflict.path]),
				error: conflict.message,
			}),
		);
	}
	const states = new Map<string, PathState>();
	const successful: {
		readonly operation: V4aPatchOperation;
		readonly stagingRoot: string;
		readonly mode: "exact" | "fuzzy" | undefined;
	}[] = [];
	let exactUpdateCount = 0;
	let fuzzyUpdateCount = 0;
	const rejectOperation = (index: number, operation: V4aPatchOperation, error: unknown): void => {
		rejectedIndices.add(index);
		rejected.push(
			Object.freeze({
				operationIndices: Object.freeze([index]),
				paths: Object.freeze([...operationTouchedPaths(operation)]),
				error: error instanceof Error ? error.message : String(error),
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
				const mode = await stageOperation(stagingRoot, operation, options.policy, options.signal);
				for (const path of operationTouchedPaths(operation)) {
					const state = states.get(path);
					if (state === undefined) throw new Error(`Missing validated patch path: ${path}`);
					states.set(path, await stagedPathState(stagingRoot, state, options.signal));
				}
				if (mode === "exact") exactUpdateCount += 1;
				if (mode === "fuzzy") fuzzyUpdateCount += 1;
				successful.push({ operation, stagingRoot, mode });
			} catch (error) {
				if (options.signal?.aborted) throw options.signal.reason ?? error;
				if (stagingRoot !== undefined) await rm(stagingRoot, { recursive: true, force: true });
				rejectOperation(index, operation, error);
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
				rejectOperation(patch.operations.indexOf(entry.operation), entry.operation, error);
				if (entry.mode === "exact") exactUpdateCount -= 1;
				if (entry.mode === "fuzzy") fuzzyUpdateCount -= 1;
				await rm(entry.stagingRoot, { recursive: true, force: true });
				successful.splice(index, 1);
			}
		}
		const committedOperations: V4aPatchOperation[] = [];
		for (const { operation, stagingRoot } of successful) {
			try {
				for (const path of operationTouchedPaths(operation)) {
					const state = states.get(path);
					if (state === undefined) throw new Error(`Missing validated patch path: ${path}`);
					await commitPath(stagingRoot, state, options.signal);
				}
				committedOperations.push(operation);
			} catch (error) {
				if (options.signal?.aborted) throw options.signal.reason ?? error;
				rejectOperation(patch.operations.indexOf(operation), operation, error);
			}
		}
		const changed = changedPaths(committedOperations);
		return Object.freeze({
			changedPaths: changed,
			operationCount: patch.operations.length,
			exactUpdateCount,
			fuzzyUpdateCount,
			rejected: Object.freeze(rejected),
		});
	} finally {
		for (const { stagingRoot } of successful)
			await rm(stagingRoot, { recursive: true, force: true });
	}
}
