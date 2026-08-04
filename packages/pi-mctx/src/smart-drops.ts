import type { MctxHistoryTag } from "./store.js";

export interface MctxSmartDropPlanInput {
	readonly tags: readonly MctxHistoryTag[];
	/** Only tags whose exact tool-result message remains imminent may be replaced. */
	readonly visibleTagNumbers: ReadonlySet<number>;
	readonly protectedTags: number;
	readonly usageTokens: number;
	/** The usage target after reclaim, normally the trigger policy's re-arm point. */
	readonly targetUsageTokens: number;
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
	const candidates = input.tags
		.filter(
			(tag) =>
				tag.kind === "tool" &&
				tag.status === "active" &&
				input.visibleTagNumbers.has(tag.tagNumber) &&
				!protectedNumbers.has(tag.tagNumber),
		)
		.sort((left, right) => left.tagNumber - right.tagNumber);
	if (candidates.length === 0) return { kind: "noop", reason: "no eligible tool results" };

	const required = input.usageTokens - input.targetUsageTokens;
	const tagNumbers: number[] = [];
	let estimatedReclaimTokens = 0;
	for (const candidate of candidates) {
		tagNumbers.push(candidate.tagNumber);
		estimatedReclaimTokens += estimatedTokens(candidate.source);
		if (estimatedReclaimTokens >= required) break;
	}
	return { kind: "drop", tagNumbers, estimatedReclaimTokens };
}
