import {
	defaultPiSettingsPaths,
	type JsonSettingsValueSource,
	readMergedJsonSettingsSection,
} from "@hheei/pi-ext-core";

export const MCTX_SETTINGS_SECTION = "pi-mctx";
export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
export const DEFAULT_FAIL_CLOSED_BLOCKING = true;

const MIN_EXECUTE_THRESHOLD_PERCENTAGE = 20;
const MAX_EXECUTE_THRESHOLD_PERCENTAGE = 80;
const MIN_EXECUTE_THRESHOLD_TOKENS = 5_000;
const MAX_EXECUTE_THRESHOLD_TOKENS = 2_000_000;

export interface MctxSettingsPaths {
	/** Global settings are the base; project settings may only apply the documented overrides. */
	readonly globalPath: string;
	/** Project settings are intentionally read fresh for each lifecycle start. */
	readonly projectPath: string;
}

/** Threshold values after model-specific selection, before trigger evaluation. */
export interface MctxThreshold {
	readonly defaultValue: number;
	readonly byModel: Readonly<Record<string, number>>;
}

export interface MctxOptionalThreshold {
	readonly defaultValue?: number;
	readonly byModel: Readonly<Record<string, number>>;
}

export interface MctxPipelineSettings {
	readonly historianModel: string;
	readonly failClosedBlocking: boolean;
	readonly executeThresholdPercentage: MctxThreshold;
	readonly executeThresholdTokens?: MctxOptionalThreshold;
}

export type MctxPipelineState =
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string }
	| { readonly kind: "enabled"; readonly settings: MctxPipelineSettings };

export interface MctxConfiguration {
	/** Raw scopes remain available for diagnostics; `pipeline` is the validated runtime view. */
	readonly global: Readonly<Record<string, unknown>>;
	readonly project: Readonly<Record<string, unknown>>;
	readonly merged: Readonly<Record<string, unknown>>;
	sourceOf(path: readonly string[]): JsonSettingsValueSource | undefined;
	readonly pipeline: MctxPipelineState;
	readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validModelRef(value: string): boolean {
	const parts = value.trim().split("/");
	return parts.length === 2 && parts[0] !== "" && parts[1] !== "" && !value.includes("\\");
}

function thresholdValue(value: unknown, minimum: number, maximum: number): value is number {
	return (
		typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
	);
}

function parseThreshold(
	value: unknown,
	minimum: number,
	maximum: number,
	defaultRequired: boolean,
): MctxOptionalThreshold | string {
	if (!isRecord(value)) return "must be an object";
	const rawDefault = value.default;
	if (defaultRequired && !thresholdValue(rawDefault, minimum, maximum)) {
		return `default must be a number between ${minimum} and ${maximum}`;
	}
	if (rawDefault !== undefined && !thresholdValue(rawDefault, minimum, maximum)) {
		return `default must be a number between ${minimum} and ${maximum}`;
	}

	const byModel: Record<string, number> = {};
	for (const [model, threshold] of Object.entries(value)) {
		if (model === "default") continue;
		if (!model || !thresholdValue(threshold, minimum, maximum)) {
			return `${model || "model key"} must be a number between ${minimum} and ${maximum}`;
		}
		byModel[model] = threshold;
	}
	return rawDefault === undefined ? { byModel } : { defaultValue: rawDefault, byModel };
}

function parsePercentage(value: unknown): MctxThreshold | string {
	if (thresholdValue(value, MIN_EXECUTE_THRESHOLD_PERCENTAGE, MAX_EXECUTE_THRESHOLD_PERCENTAGE)) {
		return { defaultValue: value, byModel: {} };
	}
	const parsed = parseThreshold(
		value,
		MIN_EXECUTE_THRESHOLD_PERCENTAGE,
		MAX_EXECUTE_THRESHOLD_PERCENTAGE,
		true,
	);
	if (typeof parsed === "string") return parsed;
	const defaultValue = parsed.defaultValue;
	if (defaultValue === undefined) return "default is required";
	return { defaultValue, byModel: parsed.byModel };
}

function parseTokens(value: unknown): MctxOptionalThreshold | string {
	return parseThreshold(value, MIN_EXECUTE_THRESHOLD_TOKENS, MAX_EXECUTE_THRESHOLD_TOKENS, false);
}

function raiseThreshold(
	base: MctxOptionalThreshold,
	override: MctxOptionalThreshold,
): MctxOptionalThreshold {
	const defaultValue =
		base.defaultValue === undefined || override.defaultValue === undefined
			? base.defaultValue
			: Math.max(base.defaultValue, override.defaultValue);
	const byModel: Record<string, number> = { ...base.byModel };
	for (const [model, value] of Object.entries(override.byModel)) {
		const baseValue = base.byModel[model] ?? base.defaultValue;
		if (baseValue === undefined || value <= baseValue) continue;
		byModel[model] = value;
	}
	return defaultValue === undefined ? { byModel } : { defaultValue, byModel };
}

function projectThreshold(
	project: Readonly<Record<string, unknown>>,
	field: string,
	parse: (value: unknown) => MctxOptionalThreshold | string,
	base: MctxOptionalThreshold,
	warnings: string[],
): MctxOptionalThreshold {
	const value = project[field];
	if (value === undefined) return base;
	const parsed = parse(value);
	if (typeof parsed === "string") {
		warnings.push(`Ignoring project ${field}: ${parsed}`);
		return base;
	}
	if (base.defaultValue === undefined && Object.keys(base.byModel).length === 0) {
		warnings.push(`Ignoring project ${field}: user config has no threshold to raise`);
		return base;
	}
	return raiseThreshold(base, parsed);
}

function resolvePipeline(
	global: Readonly<Record<string, unknown>>,
	project: Readonly<Record<string, unknown>>,
	warnings: string[],
): MctxPipelineState {
	if (global.enabled !== true || project.enabled === false) return { kind: "disabled" };
	if (project.enabled === true)
		warnings.push("Ignoring project enabled: only user config can enable pi-mctx");

	const historian = global.historian;
	if (
		!isRecord(historian) ||
		typeof historian.model !== "string" ||
		!validModelRef(historian.model)
	) {
		return { kind: "invalid", reason: "historian.model must be exact provider/model" };
	}

	const failClosedBlocking = global.fail_closed_blocking;
	if (failClosedBlocking !== undefined && typeof failClosedBlocking !== "boolean") {
		return { kind: "invalid", reason: "fail_closed_blocking must be boolean" };
	}

	const rawPercentage = global.execute_threshold_percentage;
	const percentage =
		rawPercentage === undefined
			? { defaultValue: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE, byModel: {} }
			: parsePercentage(rawPercentage);
	if (typeof percentage === "string") {
		return { kind: "invalid", reason: `execute_threshold_percentage ${percentage}` };
	}
	const projectPercentage = project.execute_threshold_percentage;
	const raisedPercentage =
		projectPercentage === undefined
			? percentage
			: projectThreshold(
					project,
					"execute_threshold_percentage",
					parsePercentage,
					percentage,
					warnings,
				);
	if (raisedPercentage.defaultValue === undefined) {
		return { kind: "invalid", reason: "execute_threshold_percentage default is required" };
	}

	const rawTokens = global.execute_threshold_tokens;
	const tokens = rawTokens === undefined ? undefined : parseTokens(rawTokens);
	if (typeof tokens === "string")
		return { kind: "invalid", reason: `execute_threshold_tokens ${tokens}` };
	const raisedTokens =
		tokens === undefined
			? undefined
			: projectThreshold(project, "execute_threshold_tokens", parseTokens, tokens, warnings);

	return {
		kind: "enabled",
		settings: {
			historianModel: historian.model.trim(),
			failClosedBlocking:
				failClosedBlocking === undefined ? DEFAULT_FAIL_CLOSED_BLOCKING : failClosedBlocking,
			executeThresholdPercentage: {
				defaultValue: raisedPercentage.defaultValue,
				byModel: raisedPercentage.byModel,
			},
			...(raisedTokens === undefined ? {} : { executeThresholdTokens: raisedTokens }),
		},
	};
}

export function defaultMctxSettingsPaths(
	cwd: string = process.cwd(),
	agentDir?: string,
): MctxSettingsPaths {
	return agentDir === undefined
		? defaultPiSettingsPaths(cwd)
		: defaultPiSettingsPaths(cwd, agentDir);
}

/**
 * Loads raw MCTX settings without mutating a live session. Only the active
 * pipeline fields are validated; reserved migration fields remain opaque JSON.
 */
export async function loadMctxConfiguration(
	paths: MctxSettingsPaths = defaultMctxSettingsPaths(),
	signal?: AbortSignal,
): Promise<MctxConfiguration> {
	// Read/merge is a configuration boundary only. The feature decides whether a
	// valid pipeline can open a store; loading settings never mutates live runtime state.
	const settings = await readMergedJsonSettingsSection({
		paths,
		section: MCTX_SETTINGS_SECTION,
		...(signal === undefined ? {} : { signal }),
	});
	const { global, project } = settings;
	const warnings: string[] = [];
	return {
		global,
		project,
		merged: settings.merged,
		sourceOf: settings.sourceOf,
		pipeline: resolvePipeline(global, project, warnings),
		warnings,
	};
}
