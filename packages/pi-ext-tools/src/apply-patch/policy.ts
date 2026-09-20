import {
	defaultExtensionSettingsPaths,
	type ExtensionSettingsPaths,
	readMergedJsonSettingsSection,
} from "@hheei/pi-ext-core";

export const APPLY_PATCH_SETTINGS_KEY = "applyPatch";
const RETIRED_KEYS = ["minSimilarity", "maxConcurrentWorkers", "maxQueueDepth"] as const;

export interface ApplyPatchPolicy {
	readonly fuzzFactor: number;
}

export interface LoadApplyPatchPolicyOptions {
	readonly paths?: ExtensionSettingsPaths;
	readonly signal?: AbortSignal;
}

export const DEFAULT_APPLY_PATCH_POLICY: ApplyPatchPolicy = {
	fuzzFactor: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(layer: string, key: string, reason: string): never {
	throw new Error(`${layer} setting ${APPLY_PATCH_SETTINGS_KEY}.${key} ${reason}`);
}

function readLayer(layer: string, value: unknown): Partial<ApplyPatchPolicy> {
	if (value === undefined) return {};
	if (!isRecord(value)) invalid(layer, "<group>", "must be an object");
	for (const key of Object.keys(value)) {
		if ((RETIRED_KEYS as readonly string[]).includes(key))
			invalid(
				layer,
				key,
				`is not supported; remove ${key} and set global ${APPLY_PATCH_SETTINGS_KEY}.fuzzFactor to 0 or 2`,
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
		paths: options.paths ?? defaultExtensionSettingsPaths(),
		section: APPLY_PATCH_SETTINGS_KEY,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	const global = readLayer("global", sections.global);
	const project = readLayer("project", sections.project);
	const baseline = global.fuzzFactor ?? DEFAULT_APPLY_PATCH_POLICY.fuzzFactor;
	if (project.fuzzFactor !== undefined && project.fuzzFactor > baseline)
		invalid("project", "fuzzFactor", `must not exceed global value ${baseline}`);
	return {
		fuzzFactor: project.fuzzFactor ?? global.fuzzFactor ?? DEFAULT_APPLY_PATCH_POLICY.fuzzFactor,
	};
}
