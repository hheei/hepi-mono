import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord, readJsonSettingsRoot, updateJsonSettingsRoot } from "@hheei/pi-ext-core";

/** One rewrite decision: the command to execute, or `null` when rtk left the command unchanged. */
export type RtkRewrite = string | null;

/** Rewrite decisions survive restarts, so a repeated command costs no spawn in later sessions either. */
export function rtkRewriteCachePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "pi-optimizer", "rtk-rewrites.json");
}

/**
 * Reads the decisions `rtk` reported for `version`.
 *
 * The version is the whole invalidation rule: `rtk` owns the rewrite table, so a different version
 * means every stored decision may be stale, while the same version keeps them valid indefinitely.
 * An unreadable, corrupt or differently versioned file is simply a cold cache.
 */
export async function readRtkRewriteCache(
	path: string,
	version: string,
	signal?: AbortSignal,
): Promise<Map<string, RtkRewrite>> {
	const rewrites = new Map<string, RtkRewrite>();
	let root: Record<string, unknown>;
	try {
		root = await readJsonSettingsRoot(path, signal);
	} catch {
		return rewrites;
	}
	if (root.version !== version || !isRecord(root.rewrites)) return rewrites;
	for (const [key, value] of Object.entries(root.rewrites)) {
		if (value === null || typeof value === "string") rewrites.set(key, value);
	}
	return rewrites;
}

/** Replaces the stored decisions with this session's, under the same cross-process lock settings use. */
export async function writeRtkRewriteCache(
	path: string,
	version: string,
	rewrites: readonly (readonly [string, RtkRewrite])[],
	signal?: AbortSignal,
): Promise<void> {
	const update = (root: Record<string, unknown>): void => {
		root.version = version;
		root.rewrites = Object.fromEntries(rewrites);
	};
	try {
		await updateJsonSettingsRoot(path, update, signal);
	} catch {
		// A cache file nobody can parse must not disable persistence forever, so replace it from scratch.
		await rm(path, { force: true });
		await updateJsonSettingsRoot(path, update, signal);
	}
}
