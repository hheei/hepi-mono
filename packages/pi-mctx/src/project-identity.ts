import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProjectIdentityResolver {
	resolve(cwd: string, signal?: AbortSignal): Promise<string>;
}

export interface ProjectIdentityResolverOptions {
	readonly canonicalize?: (cwd: string) => Promise<string>;
	readonly gitRootCommit?: (cwd: string) => Promise<string | undefined>;
	readonly lastKnownGitIdentity?: Map<string, string>;
}

declare global {
	var __hepiMctxLastKnownGitIdentities: Map<string, string> | undefined;
}

export const MCTX_LAST_KNOWN_GIT_IDENTITY_CACHE_SIZE = 64;

function defaultLastKnownGitIdentities(): Map<string, string> {
	globalThis.__hepiMctxLastKnownGitIdentities ??= new Map();
	return globalThis.__hepiMctxLastKnownGitIdentities;
}

/** Refreshes a Map entry's insertion order and evicts the least-recently-used path. */
function rememberGitIdentity(cache: Map<string, string>, path: string, identity: string): void {
	cache.delete(path);
	cache.set(path, identity);
	while (cache.size > MCTX_LAST_KNOWN_GIT_IDENTITY_CACHE_SIZE) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) return;
		cache.delete(oldest);
	}
}

function cachedGitIdentity(cache: Map<string, string>, path: string): string | undefined {
	const identity = cache.get(path);
	if (identity === undefined) return undefined;
	cache.delete(path);
	cache.set(path, identity);
	return identity;
}

function directoryIdentity(canonicalPath: string): string {
	return `dir:${createHash("sha256").update(canonicalPath).digest("hex")}`;
}

function validCommit(value: string): string | undefined {
	const commits = value
		.trim()
		.split(/\s+/)
		.filter((commit) => /^[0-9a-f]{40,64}$/i.test(commit))
		.sort();
	return commits[0];
}

async function defaultGitRootCommit(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-list", "--max-parents=0", "HEAD"], {
			cwd,
			encoding: "utf8",
		});
		return validCommit(stdout);
	} catch {
		return undefined;
	}
}

/**
 * Resolves a non-path project key. It never queries remotes or writes store
 * state; a command failure can only reuse this process's prior Git identity.
 */
export function createProjectIdentityResolver(
	options: ProjectIdentityResolverOptions = {},
): ProjectIdentityResolver {
	const canonicalize = options.canonicalize ?? realpath;
	const gitRootCommit = options.gitRootCommit ?? defaultGitRootCommit;
	const lastKnownGitIdentity = options.lastKnownGitIdentity ?? defaultLastKnownGitIdentities();
	return {
		async resolve(cwd, signal): Promise<string> {
			signal?.throwIfAborted();
			const canonicalPath = await canonicalize(cwd);
			signal?.throwIfAborted();
			const commit = await gitRootCommit(canonicalPath);
			signal?.throwIfAborted();
			if (commit !== undefined) {
				const identity = `git:${commit}`;
				rememberGitIdentity(lastKnownGitIdentity, canonicalPath, identity);
				return identity;
			}
			return (
				cachedGitIdentity(lastKnownGitIdentity, canonicalPath) ?? directoryIdentity(canonicalPath)
			);
		},
	};
}
