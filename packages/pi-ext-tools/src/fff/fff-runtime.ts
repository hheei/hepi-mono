import { createHash } from "node:crypto";
import { mkdir, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { FileFinder } from "@ff-labs/fff-node";
import { Result } from "better-result";
import { formatPathResolutionError } from "./error-format.js";
import {
	AmbiguousPathError,
	EmptyPathQueryError,
	ExternalGrepScopeError,
	FinderOperationError,
	GrepCursorMismatchError,
	InvalidGrepCursorError,
	MissingPathError,
	RuntimeInitializationError,
} from "./errors.js";
import { buildGrepText, cropMatchLine } from "./fff-format.js";
import {
	DEFAULT_FILE_CANDIDATE_LIMIT,
	DEFAULT_GREP_LIMIT,
	DEFAULT_GREP_TIMEOUT_MS,
	type EngineResult,
	type FffFileCandidate,
	type FileItem,
	type FindSearchRequest,
	type FindSearchResponse,
	type FindSearchResult,
	GREP_CURSOR_PREFIX,
	type GrepCursor,
	type GrepMatch,
	type GrepOutputMode,
	type GrepResult,
	type GrepSearchRequest,
	type GrepSearchResponse,
	type GrepSearchResult,
	type HealthCheck,
	MAX_MATCHES_PER_FILE,
	type MultiGrepRequest,
	type PathResolution,
	type RelatedFilesResponse,
	type RelatedFilesResult,
	type ResolvedPath,
	type RuntimeMetadata,
	type RuntimeOptions,
	type Score,
	type SingleGrepRequest,
} from "./fff-types.js";
import { type AppResult, errResult, propagateError, toVoidResult } from "./result-utils.js";
import { getProjectDatabasePaths } from "./runtime-paths.js";

const MAX_ADMITTED_SCAN_FILES = 20_000;
const SCAN_ADMISSION_TIMEOUT_MS = 500;
const SKIPPED_SCAN_DIRECTORIES = new Set([".git", "node_modules"]);

export async function admitFffScan(
	cwd: string,
	limits: { readonly maxFiles?: number; readonly timeoutMs?: number } = {},
): Promise<void> {
	const maxFiles = limits.maxFiles ?? MAX_ADMITTED_SCAN_FILES;
	const deadline = Date.now() + (limits.timeoutMs ?? SCAN_ADMISSION_TIMEOUT_MS);
	let fileCount = 0;
	const directories = [cwd];
	while (directories.length > 0) {
		if (Date.now() > deadline)
			throw new Error(`scan admission exceeded ${limits.timeoutMs ?? SCAN_ADMISSION_TIMEOUT_MS}ms`);
		const directory = directories.pop();
		if (directory === undefined) break;
		let handle: Awaited<ReturnType<typeof opendir>>;
		try {
			handle = await opendir(directory);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		for await (const entry of handle) {
			if (Date.now() > deadline)
				throw new Error(
					`scan admission exceeded ${limits.timeoutMs ?? SCAN_ADMISSION_TIMEOUT_MS}ms`,
				);
			if (entry.isDirectory()) {
				if (!SKIPPED_SCAN_DIRECTORIES.has(entry.name))
					directories.push(resolve(directory, entry.name));
				continue;
			}
			if (!entry.isFile()) continue;
			fileCount += 1;
			if (fileCount > maxFiles) throw new Error(`scan admission exceeded ${maxFiles} files`);
		}
	}
}

async function getPathType(path: string): Promise<"file" | "directory" | null> {
	try {
		const info = await stat(path);
		if (info.isFile()) return "file";
		if (info.isDirectory()) return "directory";
		return null;
	} catch {
		return null;
	}
}

function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

function stripQuotes(value: string): string {
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		return value.slice(1, -1);
	}
	if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
		return value.slice(1, -1);
	}
	return value;
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	return value;
}

function normalizePathQuery(value: string): string {
	let normalized = value.trim();
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	return normalizeSlashes(expandHome(stripQuotes(normalized.trim())));
}

function relativeFrom(basePath: string, targetPath: string): string {
	const rel = normalizeSlashes(relative(basePath, targetPath));
	return rel === "" ? "." : rel;
}

function isWithinBasePath(basePath: string, targetPath: string): boolean {
	const relativePath = normalizeSlashes(relative(basePath, targetPath));
	return relativePath !== ".." && !relativePath.startsWith("../") && !isAbsolute(relativePath);
}

function normalizeCandidate(item: FileItem, score: Score | undefined): FffFileCandidate {
	return score === undefined ? { item } : { item, score };
}

function scoreTotal(score: Score | undefined): number {
	return score?.total ?? Number.NEGATIVE_INFINITY;
}

function shouldAutoResolve(
	candidate: FffFileCandidate | undefined,
	nextCandidate: FffFileCandidate | undefined,
): boolean {
	if (!candidate) return false;
	if (candidate.score?.exactMatch || candidate.score?.matchType === "exact") return true;
	if (!nextCandidate) return true;
	return scoreTotal(candidate.score) > scoreTotal(nextCandidate.score) * 2;
}

function stripPathLocation(query: string): string {
	return query
		.replace(/:(\d+):(\d+)-(\d+):(\d+)$/, "")
		.replace(/:(\d+):(\d+)$/, "")
		.replace(/:(\d+)$/, "");
}

function broadenGrepPattern(pattern: string): string | null {
	const words = pattern.split(/\s+/).filter((word) => word.length > 0);
	if (words.length < 2) return null;
	return words.slice(1).join(" ");
}

function cleanupFuzzyQuery(value: string): string {
	let cleaned = "";
	for (const char of value) {
		if (char === ":" || char === "-" || char === "_") continue;
		cleaned += char.toLowerCase();
	}
	return cleaned;
}

function isStrongPathCandidate(candidate: FffFileCandidate | undefined, query: string): boolean {
	if (!candidate?.score) return false;
	if (
		candidate.score.exactMatch ||
		candidate.score.matchType === "exact" ||
		candidate.score.matchType === "prefix"
	)
		return true;
	return candidate.score.baseScore > query.length * 10;
}

function nativeConstraintForScope(scope: ResolvedPath | undefined): string | undefined {
	if (!scope) return undefined;
	const relativePath = normalizeSlashes(scope.relativePath)
		.replace(/^\.\//, "")
		.replace(/\/+$/, "");
	if (!relativePath || relativePath === ".") return undefined;
	return scope.pathType === "directory" ? `/${relativePath}/` : relativePath;
}

function nativeConstraintForGlob(glob: string | undefined): string | undefined {
	if (!glob) return undefined;
	const normalized = normalizeSlashes(glob.trim());
	return normalized || undefined;
}

function combineConstraints(...parts: Array<string | undefined>): string | undefined {
	const combined = parts
		.map((part) => part?.trim())
		.filter((part): part is string => Boolean(part));
	return combined.length > 0 ? combined.join(" ") : undefined;
}

function encodeJsonCursor(prefix: string, payload: unknown): string {
	return `${prefix}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decodeJsonCursor<T>(cursor: string | undefined, prefix: string): T | null {
	if (!cursor?.startsWith(prefix)) return null;
	try {
		const decoded = Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8");
		return JSON.parse(decoded) as T;
	} catch {
		return null;
	}
}

type GrepCursorPayload = {
	requestHash: string;
	engineOffset: number;
};

function decodeGrepCursor(cursor: string | undefined): GrepCursorPayload | null {
	const payload = decodeJsonCursor<Partial<GrepCursorPayload>>(cursor, GREP_CURSOR_PREFIX);
	const engineOffset = payload?.engineOffset;
	if (
		!payload ||
		typeof payload.requestHash !== "string" ||
		typeof engineOffset !== "number" ||
		!Number.isSafeInteger(engineOffset) ||
		engineOffset < 0
	) {
		return null;
	}
	return { requestHash: payload.requestHash, engineOffset };
}

function grepCursorAt(offset: number): GrepCursor {
	return { __brand: "GrepCursor", _offset: offset };
}

function buildSingleGrepQuery(pattern: string, constraintQuery: string | undefined): string {
	return constraintQuery ? `${constraintQuery} ${pattern}` : pattern;
}

function literalAlternatePatterns(pattern: string): string[] | null {
	if (!pattern.includes("|")) return null;
	if (pattern.includes("||") || pattern.includes("\\|")) return null;
	const parts = pattern
		.split("|")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length < 2 || parts.length > 8) return null;
	return parts;
}

function grepRequestKey(
	request: SingleGrepRequest | MultiGrepRequest,
	constraintQuery: string | undefined,
): string {
	return JSON.stringify({
		kind: request.kind,
		pattern: request.kind === "single" ? request.pattern : undefined,
		patterns: request.kind === "multi" ? request.patterns : undefined,
		mode: request.kind === "single" ? request.mode : undefined,
		constraintQuery: constraintQuery ?? null,
		limit: request.limit,
		beforeContext: request.beforeContext,
		afterContext: request.afterContext,
		includeCursorHint: request.includeCursorHint ?? false,
		outputMode: request.outputMode ?? "content",
	});
}

function grepRequestHash(
	request: SingleGrepRequest | MultiGrepRequest,
	constraintQuery: string | undefined,
): string {
	return createHash("sha256").update(grepRequestKey(request, constraintQuery)).digest("base64url");
}

function finderFailure(operation: string, reason: string, cause?: unknown): FinderOperationError {
	return new FinderOperationError({ operation, reason, cause });
}

function safeFinderCall<T>(
	operation: string,
	run: () => EngineResult<T>,
): AppResult<T, FinderOperationError> {
	const attempted = Result.try({
		try: run,
		catch: (cause) =>
			finderFailure(operation, cause instanceof Error ? cause.message : String(cause), cause),
	});
	if (attempted.isErr()) return errResult(attempted.error);
	return attempted.value.ok
		? Result.ok(attempted.value.value)
		: errResult(finderFailure(operation, attempted.value.error));
}

/**
 * Owns one project's FFF finder and its initialization generation. The extension
 * lifecycle owns disposal; callers may observe an initialization failure but must
 * not retain the finder after `dispose()` or a Pi reload.
 */
export class FffRuntime {
	public readonly cwd: string;
	private readonly options: RuntimeOptions;
	private basePath: string;
	private finder: FileFinder | null = null;
	private initPromise: Promise<AppResult<FileFinder, RuntimeInitializationError>> | null = null;
	private loadError: RuntimeInitializationError | null = null;
	private generation = 0;

	constructor(cwd: string, options: RuntimeOptions = {}) {
		this.cwd = cwd;
		this.options = options;
		this.basePath = options.projectRoot ?? cwd;
		if (options.finder) this.finder = options.finder;
	}

	async ensure(): Promise<AppResult<FileFinder, RuntimeInitializationError>> {
		// One initialization promise deduplicates concurrent tool/command calls;
		// the generation check prevents a late finder from escaping after disposal.
		if (this.finder) return Result.ok(this.finder);
		if (this.loadError) return errResult(this.loadError);
		const generation = this.generation;
		if (!this.initPromise) this.initPromise = this.initialize();
		const initialized = await this.initPromise;
		if (generation !== this.generation) {
			if (initialized.isOk() && initialized.value !== this.options.finder) {
				void Result.try({
					try: () => initialized.value.destroy(),
					catch: (cause) =>
						finderFailure("destroy", cause instanceof Error ? cause.message : String(cause), cause),
				});
			}
			return errResult(
				new RuntimeInitializationError({
					cwd: this.cwd,
					step: "initialize file finder",
					cause: new Error("FFF runtime was disposed during initialization"),
				}),
			);
		}
		if (initialized.isErr()) {
			this.loadError = initialized.error;
			return initialized;
		}
		this.loadError = null;
		this.finder = initialized.value;
		return initialized;
	}

	dispose(): void {
		// Invalidate first so an in-flight initialization cannot publish into the
		// next lifecycle. Injected finders remain caller-owned and are not destroyed.
		this.generation++;
		void Result.try({
			try: () => {
				if (this.finder && this.finder !== this.options.finder) this.finder.destroy();
			},
			catch: (cause) =>
				finderFailure("destroy", cause instanceof Error ? cause.message : String(cause), cause),
		});
		this.finder = this.options.finder ?? null;
		this.initPromise = null;
	}

	async getMetadata(): Promise<RuntimeMetadata> {
		const projectRoot = this.options.projectRoot ?? this.cwd;
		this.basePath = projectRoot;
		const root = resolve(getAgentDir(), "pi-ext-tools");
		const paths = getProjectDatabasePaths(root, projectRoot);
		return {
			cwd: this.cwd,
			projectRoot,
			dbDir: paths.dbDir,
			frecencyDbPath: paths.frecencyDbPath,
			historyDbPath: paths.historyDbPath,
			definitionClassification: "heuristic",
		};
	}

	async warm(
		timeoutMs = 1000,
	): Promise<
		AppResult<
			{ ready: boolean; indexedFiles?: number; error?: string },
			RuntimeInitializationError | FinderOperationError
		>
	> {
		const finderResult = await this.ensure();
		if (finderResult.isErr()) return propagateError(finderResult);
		const waitedResult = await Result.tryPromise({
			try: () => finderResult.value.waitForScan(timeoutMs),
			catch: (cause) =>
				finderFailure("waitForScan", cause instanceof Error ? cause.message : String(cause), cause),
		});
		if (waitedResult.isErr()) return propagateError(waitedResult);
		const health = finderResult.value.healthCheck();
		return Result.ok({
			ready: waitedResult.value.ok ? waitedResult.value.value : false,
			...(health.ok ? { indexedFiles: health.value.filePicker.indexedFiles } : {}),
			...(waitedResult.value.ok ? {} : { error: waitedResult.value.error }),
		});
	}

	async reindex(): Promise<AppResult<void, RuntimeInitializationError | FinderOperationError>> {
		const finderResult = await this.ensure();
		if (finderResult.isErr()) return propagateError(finderResult);
		return toVoidResult(safeFinderCall("scanFiles", () => finderResult.value.scanFiles()));
	}

	async getStatus(): Promise<
		AppResult<{ state: string; indexedFiles?: number; error?: string }, RuntimeInitializationError>
	> {
		const finderResult = await this.ensure();
		if (finderResult.isErr()) return propagateError(finderResult);
		const health = finderResult.value.healthCheck();
		const progress = finderResult.value.getScanProgress();
		return Result.ok({
			state: progress.ok && progress.value.isScanning ? "indexing" : "ready",
			...(health.ok && health.value.filePicker.indexedFiles !== undefined
				? { indexedFiles: health.value.filePicker.indexedFiles }
				: {}),
			...(health.ok ? {} : { error: health.error }),
		});
	}

	async healthCheck(): Promise<
		AppResult<HealthCheck, RuntimeInitializationError | FinderOperationError>
	> {
		const finderResult = await this.ensure();
		if (finderResult.isErr()) return propagateError(finderResult);
		const health = finderResult.value.healthCheck();
		return health.ok
			? Result.ok(health.value)
			: errResult(finderFailure("healthCheck", health.error));
	}

	async trackQuery(
		query: string,
		selectedPath: string,
	): Promise<AppResult<void, RuntimeInitializationError | FinderOperationError>> {
		const finderResult = await this.ensure();
		if (finderResult.isErr()) return propagateError(finderResult);
		return toVoidResult(
			safeFinderCall("trackQuery", () =>
				finderResult.value.trackQuery(normalizePathQuery(query), normalizeSlashes(selectedPath)),
			),
		);
	}

	async searchFileCandidates(
		query: string,
		limit = DEFAULT_FILE_CANDIDATE_LIMIT,
	): Promise<AppResult<FffFileCandidate[], RuntimeInitializationError | FinderOperationError>> {
		const finderResult = await this.ensure();
		if (finderResult.isErr()) return propagateError(finderResult);
		const normalizedQuery = normalizePathQuery(query);
		if (!normalizedQuery) return Result.ok([]);
		const search = safeFinderCall("fileSearch", () =>
			finderResult.value.fileSearch(normalizedQuery, {
				pageSize: Math.max(limit, DEFAULT_FILE_CANDIDATE_LIMIT),
			}),
		);
		if (search.isErr()) return propagateError(search);
		return Result.ok(
			search.value.items
				.slice(0, limit)
				.map((item, index) => normalizeCandidate(item, search.value.scores[index])),
		);
	}

	async findSearch(request: FindSearchRequest): Promise<FindSearchResult> {
		const finderResult = await this.ensure();
		if (finderResult.isErr()) return propagateError(finderResult);
		const search = safeFinderCall("fileSearch", () =>
			finderResult.value.fileSearch(request.query, {
				pageIndex: request.pageIndex,
				pageSize: request.limit,
			}),
		);
		if (search.isErr()) return propagateError(search);
		const items = search.value.items.map((item, index) =>
			normalizeCandidate(item, search.value.scores[index]),
		);
		const shownSoFar = request.pageIndex * request.limit + items.length;
		return Result.ok({
			items,
			totalMatched: search.value.totalMatched,
			totalFiles: search.value.totalFiles,
			pageIndex: request.pageIndex,
			hasMore: items.length >= request.limit && search.value.totalMatched > shownSoFar,
		} satisfies FindSearchResponse);
	}

	async resolvePath(
		query: string,
		options?: { limit?: number; allowDirectory?: boolean },
	): Promise<PathResolution> {
		const normalizedQuery = normalizePathQuery(query);
		if (!normalizedQuery) {
			return errResult(new EmptyPathQueryError({ query }));
		}

		const pathOnlyQuery = stripPathLocation(normalizedQuery);
		if (pathOnlyQuery === normalizedQuery) {
			const direct = await this.resolveExistingPath(pathOnlyQuery, options?.allowDirectory ?? true);
			if (direct) {
				return Result.ok({
					kind: "resolved",
					query,
					absolutePath: direct.absolutePath,
					relativePath: direct.relativePath,
					pathType: direct.pathType,
					candidates: [],
				});
			}
		}

		const finderResult = await this.ensure();
		if (finderResult.isErr()) return propagateError(finderResult);
		const limit = Math.max(1, options?.limit ?? DEFAULT_FILE_CANDIDATE_LIMIT);
		const search = safeFinderCall("fileSearch", () =>
			finderResult.value.fileSearch(normalizedQuery, {
				pageSize: Math.max(limit, DEFAULT_FILE_CANDIDATE_LIMIT),
			}),
		);
		if (search.isErr()) return propagateError(search);
		const candidates = search.value.items
			.slice(0, limit)
			.map((item, index) => normalizeCandidate(item, search.value.scores[index]));
		const filtered = candidates.filter(
			(candidate) =>
				options?.allowDirectory !== false || !candidate.item.relativePath.endsWith("/"),
		);

		const direct = await this.resolveExistingPath(pathOnlyQuery, options?.allowDirectory ?? true);
		if (direct) {
			return Result.ok({
				kind: "resolved",
				query,
				absolutePath: direct.absolutePath,
				relativePath: direct.relativePath,
				pathType: direct.pathType,
				...(search.value.location === undefined ? {} : { location: search.value.location }),
				candidates: filtered,
			});
		}

		const top = filtered[0];
		if (!top) {
			return errResult(
				new MissingPathError({
					query: normalizedQuery,
					reason: `No files matched "${normalizedQuery}".`,
				}),
			);
		}
		if (!shouldAutoResolve(top, filtered[1])) {
			return errResult(new AmbiguousPathError({ query, candidates: filtered }));
		}

		const absolutePath =
			top.item.path && isAbsolute(top.item.path)
				? top.item.path
				: resolve(this.basePath, top.item.relativePath);
		const pathType = (await getPathType(absolutePath)) ?? "file";
		return Result.ok({
			kind: "resolved",
			query,
			absolutePath,
			relativePath: normalizeSlashes(top.item.relativePath),
			pathType,
			...(search.value.location === undefined ? {} : { location: search.value.location }),
			candidates: filtered,
		});
	}

	async relatedFiles(query: string, limit = 8): Promise<RelatedFilesResult> {
		const baseResult = await this.resolvePath(query, { allowDirectory: false, limit: 8 });
		if (baseResult.isErr()) return propagateError(baseResult);
		const base = baseResult.value;
		const basename = normalizeSlashes(base.relativePath).split("/").pop() ?? base.relativePath;
		const stem = basename
			.replace(/\.(test|spec|stories)\./g, ".")
			.replace(/\.d\./g, ".")
			.replace(/\.module\./g, ".")
			.replace(/\.[^.]+$/, "");
		const candidatesResult = await this.searchFileCandidates(stem, Math.max(limit * 3, 20));
		if (candidatesResult.isErr()) return propagateError(candidatesResult);
		const filtered = candidatesResult.value
			.filter((candidate) => candidate.item.relativePath !== base.relativePath)
			.filter((candidate) => {
				const candidatePath = normalizeSlashes(candidate.item.relativePath);
				const candidateBase = candidatePath.split("/").pop() ?? candidatePath;
				return (
					candidateBase.includes(stem) ||
					candidatePath.includes(`${dirname(base.relativePath)}/${stem}`)
				);
			})
			.slice(0, limit);
		return Result.ok({ base, items: filtered } satisfies RelatedFilesResponse);
	}

	async grepSearch(request: GrepSearchRequest): Promise<GrepSearchResult> {
		return this.runGrep({
			kind: "single",
			pattern: request.pattern,
			mode: request.mode ?? "plain",
			...(request.pathQuery === undefined ? {} : { pathQuery: request.pathQuery }),
			...(request.glob === undefined ? {} : { glob: request.glob }),
			...(request.constraints === undefined ? {} : { constraints: request.constraints }),
			beforeContext: request.beforeContext ?? 1,
			afterContext: request.afterContext ?? 3,
			limit: request.limit ?? DEFAULT_GREP_LIMIT,
			timeBudgetMs: request.timeBudgetMs ?? DEFAULT_GREP_TIMEOUT_MS,
			...(request.cursor === undefined ? {} : { cursor: request.cursor }),
			...(request.includeCursorHint === undefined
				? {}
				: { includeCursorHint: request.includeCursorHint }),
			...(request.fuzzyFallbackOnly === undefined
				? {}
				: { fuzzyFallbackOnly: request.fuzzyFallbackOnly }),
			...(request.noMatchFallback === undefined
				? {}
				: { noMatchFallback: request.noMatchFallback }),
			...(request.outputMode === undefined ? {} : { outputMode: request.outputMode }),
		});
	}

	async multiGrepSearch(request: {
		patterns: string[];
		pathQuery?: string;
		glob?: string;
		constraints?: string;
		beforeContext?: number;
		afterContext?: number;
		limit?: number;
		cursor?: string;
		includeCursorHint?: boolean;
		outputMode?: GrepOutputMode;
	}): Promise<GrepSearchResult> {
		return this.runGrep({
			kind: "multi",
			patterns: request.patterns,
			...(request.pathQuery === undefined ? {} : { pathQuery: request.pathQuery }),
			...(request.glob === undefined ? {} : { glob: request.glob }),
			...(request.constraints === undefined ? {} : { constraints: request.constraints }),
			beforeContext: request.beforeContext ?? 1,
			afterContext: request.afterContext ?? 3,
			limit: request.limit ?? DEFAULT_GREP_LIMIT,
			timeBudgetMs: DEFAULT_GREP_TIMEOUT_MS,
			...(request.cursor === undefined ? {} : { cursor: request.cursor }),
			...(request.includeCursorHint === undefined
				? {}
				: { includeCursorHint: request.includeCursorHint }),
			...(request.outputMode === undefined ? {} : { outputMode: request.outputMode }),
		});
	}

	private buildApproximateMatchText(items: GrepMatch[]): string {
		const lines = [`0 exact matches. ${items.length} approximate:`];
		let currentFile = "";
		for (const item of items.slice(0, 3)) {
			if (item.relativePath !== currentFile) {
				currentFile = item.relativePath;
				lines.push(currentFile);
			}
			lines.push(`${item.lineNumber}:${cropMatchLine(item.lineContent, item.matchRanges).text}`);
		}
		return lines.join("\n");
	}

	private runFinderGrep(
		finder: FileFinder,
		request: SingleGrepRequest | MultiGrepRequest,
		constraintQuery: string | undefined,
		engineCursor: GrepCursor | null,
		pageSize = request.limit,
		timeBudgetMs = request.timeBudgetMs,
	): AppResult<GrepResult, FinderOperationError> {
		if (request.kind === "single") {
			if (request.mode === "plain") {
				const alternatePatterns = literalAlternatePatterns(request.pattern);
				return safeFinderCall("multiGrep", () =>
					finder.multiGrep({
						patterns: alternatePatterns ?? [request.pattern],
						...(constraintQuery === undefined ? {} : { constraints: constraintQuery }),
						cursor: engineCursor,
						beforeContext: request.beforeContext,
						afterContext: request.afterContext,
						pageSize,
						maxMatchesPerFile: MAX_MATCHES_PER_FILE,
						timeBudgetMs,
					}),
				);
			}
			return safeFinderCall("grep", () =>
				finder.grep(buildSingleGrepQuery(request.pattern, constraintQuery), {
					mode: request.mode,
					smartCase: request.kind === "single" ? request.caseSensitive !== true : true,
					cursor: engineCursor,
					beforeContext: request.beforeContext,
					afterContext: request.afterContext,
					pageSize,
					maxMatchesPerFile: MAX_MATCHES_PER_FILE,
					timeBudgetMs,
				}),
			);
		}
		return safeFinderCall("multiGrep", () =>
			finder.multiGrep({
				patterns: request.patterns,
				...(constraintQuery === undefined ? {} : { constraints: constraintQuery }),
				cursor: engineCursor,
				beforeContext: request.beforeContext,
				afterContext: request.afterContext,
				pageSize,
				maxMatchesPerFile: MAX_MATCHES_PER_FILE,
				timeBudgetMs,
			}),
		);
	}

	private buildFuzzyNoMatchFallback(
		finder: FileFinder,
		request: SingleGrepRequest,
		constraintQuery: string | undefined,
		resolvedScope: ResolvedPath | undefined,
	): GrepSearchResponse | null {
		if (request.mode === "fuzzy") return null;
		const fuzzyPattern = cleanupFuzzyQuery(request.pattern);
		if (!fuzzyPattern) return null;
		const fuzzyResult = this.runFinderGrep(
			finder,
			{ ...request, pattern: fuzzyPattern, mode: "fuzzy" },
			constraintQuery,
			null,
		);
		if (fuzzyResult.isErr()) return null;
		const items = fuzzyResult.value.items.slice(0, request.limit);
		if (items.length === 0) return null;
		return {
			items,
			formatted: this.buildApproximateMatchText(items),
			linesTruncated: false,
			approximate: "fuzzy",
			...(resolvedScope === undefined ? {} : { scope: resolvedScope }),
			...(constraintQuery === undefined ? {} : { constraintQuery }),
		};
	}

	private async buildNoMatchFallback(
		finder: FileFinder,
		request: SingleGrepRequest,
		constraintQuery: string | undefined,
		resolvedScope: ResolvedPath | undefined,
	): Promise<GrepSearchResponse | null> {
		const broadened = broadenGrepPattern(request.pattern);
		if (broadened) {
			const broadenedResult = this.runFinderGrep(
				finder,
				{ ...request, pattern: broadened },
				constraintQuery,
				null,
			);
			if (broadenedResult.isErr()) return null;
			const broadenedItems = broadenedResult.value.items.slice(0, request.limit);
			if (broadenedItems.length > 0) {
				const built = buildGrepText(broadenedItems, {
					limit: request.limit,
					requestedContext: request.beforeContext,
					includeCursorHint: false,
					...(broadenedResult.value.regexFallbackError === undefined
						? {}
						: { regexFallbackError: broadenedResult.value.regexFallbackError }),
					...(request.outputMode === undefined ? {} : { outputMode: request.outputMode }),
				});
				return {
					items: broadenedItems,
					formatted: `0 matches for "${request.pattern}". Auto-broadened to "${broadened}":\n${built.text}`,
					...(built.truncation === undefined ? {} : { truncation: built.truncation }),
					...(built.matchLimitReached === undefined
						? {}
						: { matchLimitReached: built.matchLimitReached }),
					linesTruncated: built.linesTruncated,
					...(broadenedResult.value.regexFallbackError === undefined
						? {}
						: { regexFallbackError: broadenedResult.value.regexFallbackError }),
					...(resolvedScope === undefined ? {} : { scope: resolvedScope }),
					...(constraintQuery === undefined ? {} : { constraintQuery }),
					...(built.suggestedReadPath === undefined
						? {}
						: { suggestedReadPath: built.suggestedReadPath }),
				};
			}
		}

		const fuzzyFallback = this.buildFuzzyNoMatchFallback(
			finder,
			request,
			constraintQuery,
			resolvedScope,
		);
		if (fuzzyFallback) return fuzzyFallback;

		if (request.pattern.includes("/")) {
			const pathCandidates = await this.searchFileCandidates(request.pattern, 1);
			if (
				pathCandidates.isOk() &&
				isStrongPathCandidate(pathCandidates.value[0], request.pattern)
			) {
				return {
					items: [],
					formatted: `0 content matches. But there is a relevant file path: ${pathCandidates.value[0]?.item.relativePath}`,
					linesTruncated: false,
					...(resolvedScope === undefined ? {} : { scope: resolvedScope }),
					...(constraintQuery === undefined ? {} : { constraintQuery }),
					...(pathCandidates.value[0]?.item.relativePath === undefined
						? {}
						: { suggestedReadPath: pathCandidates.value[0].item.relativePath }),
				};
			}
		}

		return null;
	}

	private async buildMultiNoMatchFallback(
		finder: FileFinder,
		request: MultiGrepRequest,
		constraintQuery: string | undefined,
		resolvedScope: ResolvedPath | undefined,
	): Promise<GrepSearchResponse | null> {
		for (const pattern of request.patterns) {
			const fallbackResult = this.runFinderGrep(
				finder,
				{
					kind: "single",
					pattern,
					mode: "plain",
					...(request.pathQuery === undefined ? {} : { pathQuery: request.pathQuery }),
					...(request.glob === undefined ? {} : { glob: request.glob }),
					...(request.constraints === undefined ? {} : { constraints: request.constraints }),
					beforeContext: request.beforeContext,
					afterContext: request.afterContext,
					limit: request.limit,
					timeBudgetMs: request.timeBudgetMs,
					includeCursorHint: false,
					...(request.outputMode === undefined ? {} : { outputMode: request.outputMode }),
				},
				constraintQuery,
				null,
			);
			if (fallbackResult.isErr()) continue;
			const fallbackItems = fallbackResult.value.items.slice(0, request.limit);
			if (fallbackItems.length === 0) continue;
			const built = buildGrepText(fallbackItems, {
				limit: request.limit,
				requestedContext: request.beforeContext,
				includeCursorHint: false,
				...(fallbackResult.value.regexFallbackError === undefined
					? {}
					: { regexFallbackError: fallbackResult.value.regexFallbackError }),
				...(request.outputMode === undefined ? {} : { outputMode: request.outputMode }),
			});
			return {
				items: fallbackItems,
				formatted: `0 multi-pattern matches. Plain grep fallback for "${pattern}":\n${built.text}`,
				...(built.truncation === undefined ? {} : { truncation: built.truncation }),
				...(built.matchLimitReached === undefined
					? {}
					: { matchLimitReached: built.matchLimitReached }),
				linesTruncated: built.linesTruncated,
				...(fallbackResult.value.regexFallbackError === undefined
					? {}
					: { regexFallbackError: fallbackResult.value.regexFallbackError }),
				...(resolvedScope === undefined ? {} : { scope: resolvedScope }),
				...(constraintQuery === undefined ? {} : { constraintQuery }),
				...(built.suggestedReadPath === undefined
					? {}
					: { suggestedReadPath: built.suggestedReadPath }),
			};
		}
		return null;
	}

	private async runGrep(request: SingleGrepRequest | MultiGrepRequest): Promise<GrepSearchResult> {
		const finderResult = await this.ensure();
		if (finderResult.isErr()) return propagateError(finderResult);
		const finder = finderResult.value;

		const scopeResult = request.pathQuery
			? await this.resolvePath(request.pathQuery, {
					allowDirectory: true,
					limit: DEFAULT_FILE_CANDIDATE_LIMIT,
				})
			: undefined;
		if (scopeResult?.isErr()) {
			if (
				AmbiguousPathError.is(scopeResult.error) ||
				EmptyPathQueryError.is(scopeResult.error) ||
				MissingPathError.is(scopeResult.error)
			) {
				return Result.ok({
					items: [],
					formatted: formatPathResolutionError(
						"grep scope",
						request.pathQuery ?? "",
						scopeResult.error,
					),
					linesTruncated: false,
				});
			}
			return propagateError(scopeResult);
		}

		const resolvedScope = scopeResult?.isOk() ? scopeResult.value : undefined;
		if (
			resolvedScope !== undefined &&
			!isWithinBasePath(this.basePath, resolvedScope.absolutePath)
		) {
			return errResult(
				new ExternalGrepScopeError({
					path: resolvedScope.absolutePath,
					projectRoot: this.basePath,
				}),
			);
		}
		const constraintQuery = combineConstraints(
			nativeConstraintForScope(resolvedScope),
			nativeConstraintForGlob(request.glob),
			request.constraints?.trim() ? request.constraints.trim() : undefined,
		);
		const requestHash = grepRequestHash(request, constraintQuery);
		const cursor = decodeGrepCursor(request.cursor);
		if (request.cursor && !cursor) {
			return errResult(new InvalidGrepCursorError({ cursor: request.cursor }));
		}
		if (cursor && cursor.requestHash !== requestHash) {
			return errResult(new GrepCursorMismatchError({ cursor: request.cursor ?? "" }));
		}

		let engineCursor = cursor ? grepCursorAt(cursor.engineOffset) : null;
		const items: GrepMatch[] = [];
		let regexFallbackError: string | undefined;

		const deadline = Date.now() + request.timeBudgetMs;

		while (items.length < request.limit) {
			if (items.length > 0 && engineCursor === null) break;
			const remainingTimeBudgetMs = deadline - Date.now();
			if (remainingTimeBudgetMs <= 0) break;

			const result = this.runFinderGrep(
				finder,
				request,
				constraintQuery,
				engineCursor,
				request.limit - items.length,
				remainingTimeBudgetMs,
			);
			if (result.isErr()) return propagateError(result);

			regexFallbackError = result.value.regexFallbackError ?? regexFallbackError;
			engineCursor = result.value.nextCursor;
			items.push(...result.value.items);
			if (!engineCursor) break;
		}

		if (
			items.length === 0 &&
			!request.cursor &&
			!request.noMatchFallback &&
			Date.now() < deadline
		) {
			if (request.kind === "single") {
				const fallback = request.fuzzyFallbackOnly
					? this.buildFuzzyNoMatchFallback(finder, request, constraintQuery, resolvedScope)
					: await this.buildNoMatchFallback(finder, request, constraintQuery, resolvedScope);
				if (fallback) return Result.ok(fallback);
			} else if (!request.fuzzyFallbackOnly) {
				const fallback = await this.buildMultiNoMatchFallback(
					finder,
					request,
					constraintQuery,
					resolvedScope,
				);
				if (fallback) return Result.ok(fallback);
			}
		}

		const nextCursor =
			engineCursor === null
				? undefined
				: encodeJsonCursor(GREP_CURSOR_PREFIX, {
						requestHash,
						engineOffset: engineCursor._offset,
					} satisfies GrepCursorPayload);

		const built = buildGrepText(items.slice(0, request.limit), {
			limit: request.limit,
			requestedContext: request.beforeContext,
			includeCursorHint: request.includeCursorHint ?? false,
			...(nextCursor === undefined ? {} : { matchLimitReached: request.limit }),
			...(nextCursor === undefined ? {} : { nextCursor }),
			...(regexFallbackError === undefined ? {} : { regexFallbackError }),
			...(request.outputMode === undefined ? {} : { outputMode: request.outputMode }),
		});
		return Result.ok({
			items: items.slice(0, request.limit),
			formatted: built.text,
			...(built.truncation === undefined ? {} : { truncation: built.truncation }),
			...(built.matchLimitReached === undefined
				? {}
				: { matchLimitReached: built.matchLimitReached }),
			linesTruncated: built.linesTruncated,
			...(regexFallbackError === undefined ? {} : { regexFallbackError }),
			...(resolvedScope === undefined ? {} : { scope: resolvedScope }),
			...(nextCursor === undefined ? {} : { nextCursor }),
			...(constraintQuery === undefined ? {} : { constraintQuery }),
			...(built.suggestedReadPath === undefined
				? {}
				: { suggestedReadPath: built.suggestedReadPath }),
		} satisfies GrepSearchResponse);
	}

	private async resolveExistingPath(
		query: string,
		allowDirectory: boolean,
	): Promise<Pick<ResolvedPath, "absolutePath" | "relativePath" | "pathType"> | null> {
		const candidates = isAbsolute(query)
			? [query]
			: query.startsWith("./") || query.startsWith("../")
				? [resolve(this.cwd, query)]
				: this.basePath === this.cwd
					? [resolve(this.cwd, query)]
					: [resolve(this.basePath, query), resolve(this.cwd, query)];
		for (const directPath of candidates) {
			const pathType = await getPathType(directPath);
			if (!pathType) continue;
			if (pathType === "directory" && !allowDirectory) continue;
			return {
				absolutePath: directPath,
				relativePath: relativeFrom(this.basePath, directPath),
				pathType,
			};
		}
		return null;
	}

	private async initialize(): Promise<AppResult<FileFinder, RuntimeInitializationError>> {
		const projectRoot = this.options.projectRoot ?? this.cwd;
		const admission = await Result.tryPromise({
			try: () => admitFffScan(projectRoot),
			catch: (cause) =>
				new RuntimeInitializationError({ cwd: this.cwd, step: "admit scan", cause }),
		});
		if (admission.isErr()) return propagateError(admission);
		const root = resolve(getAgentDir(), "pi-ext-tools");
		const rootResult = await Result.tryPromise({
			try: () => mkdir(root, { recursive: true }),
			catch: (cause) =>
				new RuntimeInitializationError({ cwd: this.cwd, step: "create runtime directory", cause }),
		});
		if (rootResult.isErr()) return propagateError(rootResult);

		this.basePath = projectRoot;
		const paths = getProjectDatabasePaths(root, projectRoot);
		const dbDir = paths.dbDir;
		const dbResult = await Result.tryPromise({
			try: () => mkdir(dbDir, { recursive: true }),
			catch: (cause) =>
				new RuntimeInitializationError({ cwd: this.cwd, step: "create database directory", cause }),
		});
		if (dbResult.isErr()) return propagateError(dbResult);

		const created = Result.try({
			try: () =>
				FileFinder.create({
					basePath: projectRoot,
					aiMode: true,
					// FFF remains a lazy, bounded session helper rather than a project daemon.
					disableMmapCache: true,
					disableContentIndexing: true,
					disableWatch: true,
					frecencyDbPath: paths.frecencyDbPath,
					historyDbPath: paths.historyDbPath,
				}),
			catch: (cause) =>
				new RuntimeInitializationError({ cwd: this.cwd, step: "create file finder", cause }),
		});
		if (created.isErr()) return propagateError(created);
		if (!created.value.ok) {
			return errResult(
				new RuntimeInitializationError({
					cwd: this.cwd,
					step: "create file finder",
					cause: created.value.error,
				}),
			);
		}

		const finder = created.value.value;
		return Result.ok(finder);
	}
}
