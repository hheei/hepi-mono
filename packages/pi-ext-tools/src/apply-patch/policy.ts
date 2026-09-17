import {
	defaultPiSettingsPaths,
	type PiSettingsPaths,
	readMergedJsonSettingsSection,
} from "@hheei/pi-ext-core";

const SECTION = "pi-ext-tools";
const GROUP = "applyPatch";
const RETIRED_KEYS = ["minSimilarity", "maxConcurrentWorkers", "maxQueueDepth"] as const;

export interface ApplyPatchPolicy {
	readonly fuzzFactor: number;
}

export interface LoadApplyPatchPolicyOptions {
	readonly paths?: PiSettingsPaths;
	readonly signal?: AbortSignal;
}

export const DEFAULT_APPLY_PATCH_POLICY: ApplyPatchPolicy = {
	fuzzFactor: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(layer: string, key: string, reason: string): never {
	throw new Error(`${layer} setting ${SECTION}.${GROUP}.${key} ${reason}`);
}

function readLayer(layer: string, value: unknown): Partial<ApplyPatchPolicy> {
	if (value === undefined) return {};
	if (!isRecord(value)) invalid(layer, "<group>", "must be an object");
	for (const key of Object.keys(value)) {
		if ((RETIRED_KEYS as readonly string[]).includes(key))
			invalid(
				layer,
				key,
				`is not supported; remove ${key} and set global ${SECTION}.${GROUP}.fuzzFactor to 0 or 2`,
			);
		if (key !== "fuzzFactor") invalid(layer, key, "is not supported");
	}
	if (!Object.hasOwn(value, "fuzzFactor")) return {};
	const item = value.fuzzFactor;
	if (typeof item !== "number" || !Number.isFinite(item))
		invalid(layer, "fuzzFactor", "must be a finite number");
	if (!Number.isInteger(item) || item < 0 || item > 2)
		invalid(layer, "fuzzFactor", "must be an integer from 0 to 2");
	return { fuzzFactor: item };
}

export async function loadApplyPatchPolicy(
	options: LoadApplyPatchPolicyOptions = {},
): Promise<ApplyPatchPolicy> {
	const sections = await readMergedJsonSettingsSection({
		paths: options.paths ?? defaultPiSettingsPaths(),
		section: SECTION,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	const globalSection = isRecord(sections.global) ? sections.global[GROUP] : undefined;
	const projectSection = isRecord(sections.project) ? sections.project[GROUP] : undefined;
	const global = readLayer("global", globalSection);
	const project = readLayer("project", projectSection);
	const baseline = global.fuzzFactor ?? DEFAULT_APPLY_PATCH_POLICY.fuzzFactor;
	if (project.fuzzFactor !== undefined && project.fuzzFactor > baseline)
		invalid("project", "fuzzFactor", `must not exceed global value ${baseline}`);
	return {
		fuzzFactor: project.fuzzFactor ?? global.fuzzFactor ?? DEFAULT_APPLY_PATCH_POLICY.fuzzFactor,
	};
}
