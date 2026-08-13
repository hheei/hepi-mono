import {
	defaultPiSettingsPaths,
	type PiSettingsPaths,
	readMergedJsonSettingsSection,
} from "@hheei/pi-ext-core";

const SECTION = "pi-ext-tools";
const GROUP = "applyPatch";

export interface FuzzyApplyPatchPolicy {
	readonly minSimilarity: number;
	readonly maxConcurrentWorkers: number;
	readonly maxQueueDepth: number;
}

export interface LoadFuzzyApplyPatchPolicyOptions {
	readonly paths?: PiSettingsPaths;
	readonly signal?: AbortSignal;
}

export const DEFAULT_FUZZY_APPLY_PATCH_POLICY: FuzzyApplyPatchPolicy = {
	minSimilarity: 0.7,
	maxConcurrentWorkers: 2,
	maxQueueDepth: 32,
};

type PolicyKey = keyof FuzzyApplyPatchPolicy;
const POLICY_KEYS: readonly PolicyKey[] = [
	"minSimilarity",
	"maxConcurrentWorkers",
	"maxQueueDepth",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(layer: string, key: string, reason: string): never {
	throw new Error(`${layer} setting ${SECTION}.${GROUP}.${key} ${reason}`);
}

function readLayer(layer: string, value: unknown): Partial<FuzzyApplyPatchPolicy> {
	if (value === undefined) return {};
	if (!isRecord(value)) invalid(layer, "<group>", "must be an object");
	for (const key of Object.keys(value)) {
		if (!POLICY_KEYS.some((candidate) => candidate === key))
			invalid(layer, key, "is not supported");
	}
	const result: Partial<FuzzyApplyPatchPolicy> = {};
	for (const key of POLICY_KEYS) {
		if (!Object.hasOwn(value, key)) continue;
		const item = value[key];
		if (typeof item !== "number" || !Number.isFinite(item))
			invalid(layer, key, "must be a finite number");
		if (key === "minSimilarity") {
			if (item < 0 || item > 1) invalid(layer, key, "must be between 0 and 1");
		} else if (!Number.isInteger(item)) {
			invalid(layer, key, "must be an integer");
		} else if (key === "maxConcurrentWorkers" && (item < 1 || item > 16)) {
			invalid(layer, key, "must be an integer from 1 to 16");
		} else if (key === "maxQueueDepth" && (item < 1 || item > 512)) {
			invalid(layer, key, "must be an integer from 1 to 512");
		}
		Object.assign(result, { [key]: item });
	}
	return result;
}

function mergedPolicy(
	global: Partial<FuzzyApplyPatchPolicy>,
	project: Partial<FuzzyApplyPatchPolicy>,
): FuzzyApplyPatchPolicy {
	for (const key of POLICY_KEYS) {
		if (!Object.hasOwn(project, key)) continue;
		const value = project[key];
		if (value === undefined) continue;
		const baseline = global[key] ?? DEFAULT_FUZZY_APPLY_PATCH_POLICY[key];
		if (typeof value === "number" && typeof baseline === "number") {
			if (key === "minSimilarity" && value !== 0 && value < baseline)
				invalid("project", key, `must be at least global value ${baseline}`);
			if ((key === "maxConcurrentWorkers" || key === "maxQueueDepth") && value > baseline)
				invalid("project", key, `must not exceed global value ${baseline}`);
		}
	}
	return {
		minSimilarity:
			project.minSimilarity ??
			global.minSimilarity ??
			DEFAULT_FUZZY_APPLY_PATCH_POLICY.minSimilarity,
		maxConcurrentWorkers:
			project.maxConcurrentWorkers ??
			global.maxConcurrentWorkers ??
			DEFAULT_FUZZY_APPLY_PATCH_POLICY.maxConcurrentWorkers,
		maxQueueDepth:
			project.maxQueueDepth ??
			global.maxQueueDepth ??
			DEFAULT_FUZZY_APPLY_PATCH_POLICY.maxQueueDepth,
	};
}

export async function loadFuzzyApplyPatchPolicy(
	options: LoadFuzzyApplyPatchPolicyOptions = {},
): Promise<FuzzyApplyPatchPolicy> {
	const sections = await readMergedJsonSettingsSection({
		paths: options.paths ?? defaultPiSettingsPaths(),
		section: SECTION,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	const globalSection = isRecord(sections.global) ? sections.global[GROUP] : undefined;
	const projectSection = isRecord(sections.project) ? sections.project[GROUP] : undefined;
	return mergedPolicy(readLayer("global", globalSection), readLayer("project", projectSection));
}
