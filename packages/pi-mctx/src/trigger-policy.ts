export const DEFAULT_TRIGGER_PERCENTAGE = 65;
export const MIN_TRIGGER_PERCENTAGE = 20;
export const MAX_TRIGGER_PERCENTAGE = 80;
const HYSTERESIS_PERCENTAGE_POINTS = 10;

export interface MctxTriggerPolicyInput {
	readonly usageTokens: number;
	readonly contextWindow?: number | null;
	readonly percentage?: number;
	readonly absoluteThreshold?: number;
	readonly cooling: boolean;
}

export type MctxTriggerPolicyDecision =
	| { readonly kind: "unavailable"; readonly cooling: boolean }
	| { readonly kind: "wait"; readonly cooling: boolean; readonly thresholdTokens: number }
	| { readonly kind: "trigger"; readonly cooling: true; readonly thresholdTokens: number }
	| { readonly kind: "rearmed"; readonly cooling: false; readonly thresholdTokens: number };

function requirePositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
}

function resolvePercentage(percentage: number | undefined): number {
	const resolved = percentage ?? DEFAULT_TRIGGER_PERCENTAGE;
	if (
		typeof resolved !== "number" ||
		!Number.isFinite(resolved) ||
		resolved < MIN_TRIGGER_PERCENTAGE ||
		resolved > MAX_TRIGGER_PERCENTAGE
	) {
		throw new RangeError(
			`percentage must be a number between ${MIN_TRIGGER_PERCENTAGE} and ${MAX_TRIGGER_PERCENTAGE}`,
		);
	}
	return resolved;
}

/**
 * Computes one trigger state transition without registering Pi lifecycle work.
 */
export function evaluateMctxTriggerPolicy(
	input: MctxTriggerPolicyInput,
): MctxTriggerPolicyDecision {
	requirePositiveSafeInteger(input.usageTokens, "usageTokens");
	const percentage = resolvePercentage(input.percentage);
	const contextWindow = input.contextWindow;
	if (contextWindow !== null && contextWindow !== undefined) {
		requirePositiveSafeInteger(contextWindow, "contextWindow");
	}
	const absoluteThreshold = input.absoluteThreshold;
	if (absoluteThreshold !== undefined) {
		requirePositiveSafeInteger(absoluteThreshold, "absoluteThreshold");
	}

	const percentageThreshold =
		contextWindow === null || contextWindow === undefined
			? undefined
			: Math.ceil((contextWindow * percentage) / 100);
	// A known context window and explicit absolute floor combine conservatively:
	// either source can delay work, but neither can cause an earlier trigger.
	const thresholdTokens =
		percentageThreshold === undefined
			? absoluteThreshold
			: absoluteThreshold === undefined
				? percentageThreshold
				: Math.max(percentageThreshold, absoluteThreshold);
	if (thresholdTokens === undefined) return { kind: "unavailable", cooling: input.cooling };

	if (!input.cooling) {
		return input.usageTokens >= thresholdTokens
			? { kind: "trigger", cooling: true, thresholdTokens }
			: { kind: "wait", cooling: false, thresholdTokens };
	}

	const percentageRearmThreshold =
		contextWindow === null || contextWindow === undefined
			? undefined
			: Math.floor((contextWindow * (percentage - HYSTERESIS_PERCENTAGE_POINTS)) / 100);
	const absoluteRearmThreshold =
		absoluteThreshold === undefined ? undefined : Math.floor(absoluteThreshold * 0.9);
	// Rearm below both thresholds to avoid repeated historian starts while usage
	// oscillates near the trigger boundary.
	const rearmed =
		(percentageRearmThreshold === undefined || input.usageTokens <= percentageRearmThreshold) &&
		(absoluteRearmThreshold === undefined || input.usageTokens <= absoluteRearmThreshold);
	return rearmed
		? { kind: "rearmed", cooling: false, thresholdTokens }
		: { kind: "wait", cooling: true, thresholdTokens };
}
