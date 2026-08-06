import type { MctxVisibleToolTag } from "./history-tags.js";
import type { MctxHistoryTag } from "./store.js";

export interface MctxSmartDropPlanInput {
	readonly tags: readonly MctxHistoryTag[];
	/** Only exact tool-result identities in the verified live tail may be replaced. */
	readonly candidates: readonly MctxVisibleToolTag[];
	readonly protectedTags: number;
	readonly usageTokens: number;
	/** The usage target after reclaim, normally the trigger policy's re-arm point. */
	readonly targetUsageTokens: number;
	/** Emergency recovery drops every eligible live-tail tool result. */
	readonly forceAll?: boolean;
}

type MctxToolTier = 1 | 2 | 3;

function toolTier(name: string): MctxToolTier {
	const normalized = name.toLowerCase().replace(/^mcp_/u, "");
	if (["read", "todowrite", "task", "aft_outline", "aft_zoom"].includes(normalized)) return 1;
	if (["edit", "write", "apply_patch", "grep", "glob", "aft_search"].includes(normalized)) return 2;
	return 3;
}

/** Preserves the newest fifth of continuation tools before pressure eviction. */
function tierOrderedCandidates(
	candidates: readonly MctxVisibleToolTag[],
): readonly MctxVisibleToolTag[] {
	const reserved = new Set<number>();
	for (const tier of [1, 2] as const) {
		const members = candidates
			.filter((candidate) => toolTier(candidate.toolName) === tier)
			.sort((left, right) => right.tag.tagNumber - left.tag.tagNumber);
		for (const candidate of members.slice(0, Math.ceil(members.length / 5)))
			reserved.add(candidate.tag.tagNumber);
	}
	return [...candidates]
		.filter((candidate) => !reserved.has(candidate.tag.tagNumber))
		.sort((left, right) => {
			const tier = toolTier(right.toolName) - toolTier(left.toolName);
			return tier === 0 ? left.tag.tagNumber - right.tag.tagNumber : tier;
		});
}

function recordString(value: unknown, keys: readonly string[]): string | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	for (const key of keys) {
		const candidate = (value as Readonly<Record<string, unknown>>)[key];
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}
	return undefined;
}

function heuristicTagNumbers(candidates: readonly MctxVisibleToolTag[]): ReadonlySet<number> {
	const selected = new Set<number>();
	const byNewest = [...candidates].sort((left, right) => right.tag.tagNumber - left.tag.tagNumber);
	let todoSeen = 0;
	let reduceSeen = 0;
	const newestEditByPath = new Set<string>();
	for (const candidate of byNewest) {
		const name = candidate.toolName.toLowerCase();
		if (name === "bash_status" || name === "bash_kill") {
			selected.add(candidate.tag.tagNumber);
			continue;
		}
		if (name === "todowrite") {
			todoSeen++;
			if (todoSeen > 1) selected.add(candidate.tag.tagNumber);
			continue;
		}
		if (name === "ctx_reduce") {
			reduceSeen++;
			if (reduceSeen > 5) selected.add(candidate.tag.tagNumber);
			continue;
		}
		if (name !== "edit" && name !== "write" && name !== "apply_patch") continue;
		const path = recordString(candidate.input, ["filePath", "file_path", "path"]);
		if (path === undefined) continue;
		if (newestEditByPath.has(path)) selected.add(candidate.tag.tagNumber);
		else newestEditByPath.add(path);
	}
	return selected;
}

export type MctxSmartDropPlan =
	| { readonly kind: "noop"; readonly reason: string }
	| {
			readonly kind: "drop";
			readonly tagNumbers: readonly number[];
			readonly estimatedReclaimTokens: number;
	  };

function estimatedTokens(source: string): number {
	// The source is retained text, not provider-tokenized content. Four UTF-16 code
	// units per token is intentionally a stable planning estimate, not an accounting value.
	return Math.max(1, Math.ceil(source.length / 4));
}

/**
 * Selects only branch-proven old tool results. This is intentionally pure so
 * feature lifecycle code owns usage sampling and store mutation separately.
 */
export function planMctxSmartDrops(input: MctxSmartDropPlanInput): MctxSmartDropPlan {
	if (!Number.isSafeInteger(input.usageTokens) || input.usageTokens <= 0)
		throw new RangeError("usageTokens must be a positive safe integer");
	if (!Number.isSafeInteger(input.targetUsageTokens) || input.targetUsageTokens < 0)
		throw new RangeError("targetUsageTokens must be a non-negative safe integer");
	if (!Number.isSafeInteger(input.protectedTags) || input.protectedTags < 1)
		throw new RangeError("protectedTags must be a positive safe integer");
	if (input.usageTokens <= input.targetUsageTokens)
		return { kind: "noop", reason: "usage is already below target" };

	const activeTagNumbers = input.tags
		.filter((tag) => tag.status === "active")
		.map((tag) => tag.tagNumber)
		.sort((left, right) => right - left);
	const protectedNumbers = new Set(activeTagNumbers.slice(0, input.protectedTags));
	const candidates = input.candidates
		.filter(
			(candidate) =>
				candidate.tag.status === "active" && !protectedNumbers.has(candidate.tag.tagNumber),
		)
		.sort((left, right) => left.tag.tagNumber - right.tag.tagNumber);
	if (candidates.length === 0) return { kind: "noop", reason: "no eligible tool results" };

	const required = input.usageTokens - input.targetUsageTokens;
	const tagNumbers: number[] = [];
	let estimatedReclaimTokens = 0;
	const heuristic = heuristicTagNumbers(candidates);
	for (const candidate of candidates) {
		if (!heuristic.has(candidate.tag.tagNumber)) continue;
		tagNumbers.push(candidate.tag.tagNumber);
		estimatedReclaimTokens += estimatedTokens(candidate.tag.source);
	}
	for (const candidate of tierOrderedCandidates(candidates)) {
		if (heuristic.has(candidate.tag.tagNumber)) continue;
		tagNumbers.push(candidate.tag.tagNumber);
		estimatedReclaimTokens += estimatedTokens(candidate.tag.source);
		if (!input.forceAll && estimatedReclaimTokens >= required) break;
	}
	return { kind: "drop", tagNumbers, estimatedReclaimTokens };
}
