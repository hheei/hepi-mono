import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_SOURCE_CHARS = 8_000;
const MAX_PRIMER_BYTES = 128 * 1_024;
const MAX_GIT_COMMITS = 100;

export const MCTX_SEARCH_SOURCES = ["memory", "note", "history", "git", "primer"] as const;
export type MctxSearchSource = (typeof MCTX_SEARCH_SOURCES)[number];

export interface MctxSearchCandidate {
	readonly source: MctxSearchSource;
	readonly id: string;
	readonly title: string;
	readonly text: string;
}

export interface MctxSearchHit {
	readonly source: MctxSearchSource;
	readonly id: string;
	readonly title: string;
	readonly snippet: string;
}

export interface MctxExternalSearchInput {
	readonly cwd: string;
	readonly primerPath?: string;
	readonly sources: readonly MctxSearchSource[];
	readonly signal: AbortSignal;
}

const sourceRank = new Map<MctxSearchSource, number>(
	MCTX_SEARCH_SOURCES.map((source, index) => [source, index]),
);

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function mctxSearchContentHash(value: string): string {
	return hash(value);
}

export function boundedMctxSearchText(value: string): string {
	return value.length <= MAX_SOURCE_CHARS ? value : value.slice(0, MAX_SOURCE_CHARS);
}

function tokens(value: string): readonly string[] {
	return [
		...new Set(
			(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(
				(token) => token.length > 0,
			),
		),
	];
}

function score(
	text: string,
	queryTokens: readonly string[],
): { readonly score: number; readonly first: number } | undefined {
	const normalized = text.toLocaleLowerCase();
	let total = 0;
	let matched = 0;
	let first = Number.POSITIVE_INFINITY;
	for (const token of queryTokens) {
		let index = normalized.indexOf(token);
		if (index < 0) continue;
		matched++;
		while (index >= 0) {
			total++;
			if (index < first) first = index;
			index = normalized.indexOf(token, index + token.length);
		}
	}
	return matched === 0 ? undefined : { score: matched * 1_000 + total, first };
}

function snippet(text: string, first: number): string {
	const normalized = text.replace(/\s+/gu, " ").trim();
	const start = Math.max(0, first - 180);
	const end = Math.min(normalized.length, start + 500);
	return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

function stableCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareRankedCandidates(
	left: { readonly candidate: MctxSearchCandidate; readonly score: number },
	right: { readonly candidate: MctxSearchCandidate; readonly score: number },
): number {
	if (right.score !== left.score) return right.score - left.score;
	const sourceDifference =
		(sourceRank.get(left.candidate.source) ?? Number.POSITIVE_INFINITY) -
		(sourceRank.get(right.candidate.source) ?? Number.POSITIVE_INFINITY);
	return sourceDifference !== 0
		? sourceDifference
		: stableCompare(left.candidate.id, right.candidate.id);
}

/** Ranks only caller-admitted, bounded snapshots; it never queries persistent storage. */
export function rankMctxSearchCandidates(
	query: string,
	candidates: readonly MctxSearchCandidate[],
	limit: number,
): readonly MctxSearchHit[] {
	const queryTokens = tokens(query);
	if (queryTokens.length === 0) return [];
	const admitted = candidates
		.flatMap((candidate) => {
			const match = score(candidate.text, queryTokens);
			return match === undefined ? [] : [{ candidate, ...match }];
		})
		.sort(compareRankedCandidates);
	const identities = new Set<string>();
	const identityUnique = admitted.filter(({ candidate }) => {
		const identity = `${candidate.source}\u0000${candidate.id}`;
		if (identities.has(identity)) return false;
		identities.add(identity);
		return true;
	});
	const contents = new Set<string>();
	return identityUnique
		.filter(({ candidate }) => {
			const content = `${candidate.source}\u0000${mctxSearchContentHash(candidate.text)}`;
			if (contents.has(content)) return false;
			contents.add(content);
			return true;
		})
		.slice(0, limit)
		.map(({ candidate, first }) => ({
			source: candidate.source,
			id: candidate.id,
			title: candidate.title,
			snippet: snippet(candidate.text, first),
		}));
}

function outside(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function primerCandidate(
	cwd: string,
	primerPath: string | undefined,
	signal: AbortSignal,
): Promise<MctxSearchCandidate | undefined> {
	if (primerPath === undefined) return undefined;
	try {
		signal.throwIfAborted();
		const root = await realpath(cwd);
		const requested = resolve(root, primerPath);
		if (outside(root, requested)) return undefined;
		const path = await realpath(requested);
		if (outside(root, path)) return undefined;
		const stats = await lstat(path);
		if (!stats.isFile() || stats.size > MAX_PRIMER_BYTES) return undefined;
		const content = await readFile(path, "utf8");
		if (content.includes("\0")) return undefined;
		signal.throwIfAborted();
		return {
			source: "primer",
			id: `primer:${relative(root, path)}:${hash(content)}`,
			title: `Primer ${relative(root, path)}`,
			text: boundedMctxSearchText(content),
		};
	} catch (error: unknown) {
		if (signal.aborted) throw error;
		return undefined;
	}
}

function gitCandidates(output: string): readonly MctxSearchCandidate[] {
	const fields = output.split("\0");
	const candidates: MctxSearchCandidate[] = [];
	for (let index = 0; index + 4 < fields.length; index += 5) {
		const commit = fields[index];
		const subject = fields[index + 1];
		const author = fields[index + 2];
		const timestamp = fields[index + 3];
		const body = fields[index + 4];
		if (
			commit === undefined ||
			subject === undefined ||
			author === undefined ||
			timestamp === undefined ||
			body === undefined ||
			!/^[0-9a-f]{40,64}$/iu.test(commit)
		)
			continue;
		candidates.push({
			source: "git",
			id: `git:${commit}`,
			title: `Commit ${commit.slice(0, 12)}: ${subject}`,
			text: boundedMctxSearchText([subject, author, timestamp, body].join("\n")),
		});
	}
	return candidates;
}

async function gitSearchCandidates(
	cwd: string,
	signal: AbortSignal,
): Promise<readonly MctxSearchCandidate[]> {
	try {
		const result = await execFileAsync(
			"git",
			[
				"log",
				"--no-ext-diff",
				`--max-count=${MAX_GIT_COMMITS}`,
				"--format=%H%x00%s%x00%an%x00%aI%x00%b%x00",
				"HEAD",
			],
			{ cwd, encoding: "utf8", maxBuffer: 1_048_576, signal },
		);
		signal.throwIfAborted();
		return gitCandidates(result.stdout);
	} catch (error: unknown) {
		if (signal.aborted) throw error;
		return [];
	}
}

/** Git and primer failures remove only that source; abort remains owned by the tool call. */
export async function collectMctxExternalSearchCandidates(
	input: MctxExternalSearchInput,
): Promise<readonly MctxSearchCandidate[]> {
	const [git, primer] = await Promise.all([
		input.sources.includes("git") ? gitSearchCandidates(input.cwd, input.signal) : [],
		input.sources.includes("primer")
			? primerCandidate(input.cwd, input.primerPath, input.signal)
			: undefined,
	]);
	return primer === undefined ? git : [...git, primer];
}
