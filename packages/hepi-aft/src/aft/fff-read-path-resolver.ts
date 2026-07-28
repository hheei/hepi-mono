import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { FileFinder, type Location, type Score, type SearchResult } from "@ff-labs/fff-node";
import {
	acquireSharedFffFinder,
	type SharedFffFinderLease,
} from "../../../hepi-basics/src/core/index.js";

const CANDIDATE_LIMIT = 8;

type FileCandidate = {
	readonly relativePath: string;
	readonly totalFrecencyScore: number;
	readonly gitStatus: string;
	readonly score: Score | undefined;
};

type FffReadFinder = Pick<FileFinder, "destroy" | "fileSearch" | "trackQuery" | "waitForScan">;

export type ResolvedFffReadPath = {
	readonly absolutePath: string;
	readonly location: Location | undefined;
};

export function locationToReadParams(
	location: Location | undefined,
	offset: number | undefined,
	limit: number | undefined,
): { offset: number | undefined; limit: number | undefined } {
	if (offset !== undefined || location === undefined) return { offset, limit };
	if (location.type === "line" || location.type === "position") {
		return { offset: location.line, limit: limit ?? 80 };
	}
	const rangeSize = Math.max(1, location.end.line - location.start.line + 1);
	return { offset: location.start.line, limit: limit ?? Math.max(rangeSize, 20) };
}

function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

function stripQuotes(value: string): string {
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1);
	if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
	return value;
}

function normalizePathQuery(value: string): string {
	let normalized = stripQuotes(value.trim());
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/")) normalized = resolve(homedir(), normalized.slice(2));
	return normalizeSlashes(normalized.trim());
}

function stripPathLocation(query: string): string {
	return query
		.replace(/:(\d+):(\d+)-(\d+):(\d+)$/, "")
		.replace(/:(\d+):(\d+)$/, "")
		.replace(/:(\d+)$/, "");
}

function scoreTotal(score: Score | undefined): number {
	return score?.total ?? Number.NEGATIVE_INFINITY;
}

function shouldAutoResolve(
	candidate: FileCandidate,
	nextCandidate: FileCandidate | undefined,
): boolean {
	if (candidate.score?.exactMatch || candidate.score?.matchType === "exact") return true;
	if (nextCandidate === undefined) return true;
	return scoreTotal(candidate.score) > scoreTotal(nextCandidate.score) * 2;
}

function formatCandidates(candidates: readonly FileCandidate[]): string[] {
	return candidates.map((candidate, index) => {
		const matchType = candidate.score?.matchType;
		const frecency =
			candidate.totalFrecencyScore >= 100
				? " - hot"
				: candidate.totalFrecencyScore >= 50
					? " - warm"
					: candidate.totalFrecencyScore >= 10
						? " - frequent"
						: "";
		const git =
			candidate.gitStatus && candidate.gitStatus !== "clean" ? ` git:${candidate.gitStatus}` : "";
		return `${index + 1}. ${candidate.relativePath}${matchType ? ` (${matchType})` : ""}${frecency}${git}`;
	});
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

async function resolveProjectRoot(cwd: string): Promise<string> {
	let current = resolve(cwd);
	for (;;) {
		if ((await getPathType(resolve(current, ".git"))) === "directory") return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

function databasePaths(projectRoot: string): { frecencyDbPath: string; historyDbPath: string } {
	const key = createHash("sha1").update(projectRoot).digest("hex").slice(0, 12);
	const dbDir = resolve(getAgentDir(), "pi-fff", key);
	return {
		frecencyDbPath: resolve(dbDir, "frecency.db"),
		historyDbPath: resolve(dbDir, "history.db"),
	};
}

export class FffReadPathResolver {
	private finder: FffReadFinder | undefined;
	private finderLease: SharedFffFinderLease<FileFinder> | undefined;
	private finderPromise: Promise<FffReadFinder> | undefined;
	private generation = 0;
	private projectRoot: string | undefined;

	constructor(
		private readonly cwd: string,
		options: { readonly finder?: FffReadFinder; readonly projectRoot?: string } = {},
	) {
		this.finder = options.finder;
		this.projectRoot = options.projectRoot;
	}

	dispose(): void {
		this.generation += 1;
		const lease = this.finderLease;
		this.finderLease = undefined;
		this.finderPromise = undefined;
		if (lease) lease.release();
		else this.finder?.destroy();
		this.finder = undefined;
	}

	async resolvePath(query: string): Promise<ResolvedFffReadPath> {
		const normalizedQuery = normalizePathQuery(query);
		if (!normalizedQuery) throw new Error("Path query is empty.");

		const pathOnlyQuery = stripPathLocation(normalizedQuery);
		if (pathOnlyQuery === normalizedQuery) {
			const direct = await this.resolveExistingFile(pathOnlyQuery);
			if (direct !== undefined) return { absolutePath: direct, location: undefined };
		}

		const finder = await this.getFinder();
		const search = finder.fileSearch(normalizedQuery, { pageSize: CANDIDATE_LIMIT });
		if (!search.ok) throw new Error(`FFF file search failed: ${search.error}`);
		const candidates = this.fileCandidates(search.value);

		const direct = await this.resolveExistingFile(pathOnlyQuery);
		if (direct !== undefined) {
			void finder.trackQuery(normalizedQuery, normalizeSlashes(direct));
			return { absolutePath: direct, location: search.value.location };
		}

		const top = candidates[0];
		if (top === undefined) throw new Error(`No files matched "${normalizedQuery}".`);
		if (!shouldAutoResolve(top, candidates[1])) {
			throw new Error(
				[
					`Could not resolve "${query}" uniquely for read.`,
					"Top matches:",
					...formatCandidates(candidates),
				].join("\n"),
			);
		}

		const absolutePath = resolve(await this.getProjectRoot(), top.relativePath);
		if ((await getPathType(absolutePath)) !== "file") {
			throw new Error(`Resolved path is not a readable file: ${top.relativePath}`);
		}
		void finder.trackQuery(normalizedQuery, normalizeSlashes(absolutePath));
		return { absolutePath, location: search.value.location };
	}

	private async resolveExistingFile(query: string): Promise<string | undefined> {
		const root = await this.getProjectRoot();
		const candidates =
			isAbsolute(query) || query.startsWith("./") || query.startsWith("../")
				? [resolve(this.cwd, query)]
				: root === this.cwd
					? [resolve(this.cwd, query)]
					: [resolve(root, query), resolve(this.cwd, query)];
		for (const candidate of candidates) {
			if ((await getPathType(candidate)) === "file") return candidate;
		}
		return undefined;
	}

	private async getProjectRoot(): Promise<string> {
		if (this.projectRoot === undefined) this.projectRoot = await resolveProjectRoot(this.cwd);
		return this.projectRoot;
	}

	private async getFinder(): Promise<FffReadFinder> {
		if (this.finder !== undefined) return this.finder;
		if (this.finderPromise !== undefined) return await this.finderPromise;
		const generation = this.generation;
		const initialize = async (): Promise<FffReadFinder> => {
			const projectRoot = await this.getProjectRoot();
			const paths = databasePaths(projectRoot);
			await mkdir(dirname(paths.frecencyDbPath), { recursive: true });
			const lease = acquireSharedFffFinder(
				paths.frecencyDbPath,
				(): FileFinder => {
					const finder = FileFinder.create({ basePath: projectRoot, aiMode: true, ...paths });
					if (!finder.ok) throw new Error(`FFF file finder initialization failed: ${finder.error}`);
					return finder.value;
				},
				(finder) => finder.destroy(),
			);
			if (generation !== this.generation) {
				lease.release();
				throw new Error("FFF read path resolver was disposed during initialization.");
			}
			this.finderLease = lease;
			this.finder = lease.finder;
			void this.finder.waitForScan(500);
			return this.finder;
		};
		const promise = initialize();
		this.finderPromise = promise;
		try {
			return await promise;
		} finally {
			if (this.finderPromise === promise) this.finderPromise = undefined;
		}
	}

	private fileCandidates(search: SearchResult): FileCandidate[] {
		return search.items.slice(0, CANDIDATE_LIMIT).map((item, index) => ({
			relativePath: item.relativePath,
			totalFrecencyScore: item.totalFrecencyScore,
			gitStatus: item.gitStatus,
			score: search.scores[index],
		}));
	}
}
