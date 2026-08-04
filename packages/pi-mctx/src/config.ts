import { isAbsolute } from "node:path";
import {
	defaultPiSettingsPaths,
	type JsonSettingsValueSource,
	readMergedJsonSettingsSection,
} from "@hheei/pi-ext-core";
import { validModelRef } from "./model-ref.js";

export const MCTX_SETTINGS_SECTION = "pi-mctx";
export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
export const DEFAULT_FAIL_CLOSED_BLOCKING = true;
export const DEFAULT_PROTECTED_TAGS = 20;

const MIN_EXECUTE_THRESHOLD_PERCENTAGE = 20;
const MAX_EXECUTE_THRESHOLD_PERCENTAGE = 80;
const MIN_EXECUTE_THRESHOLD_TOKENS = 5_000;
const MAX_EXECUTE_THRESHOLD_TOKENS = 2_000_000;
const MIN_PROTECTED_TAGS = 1;
const MAX_PROTECTED_TAGS = 100;

export interface MctxSettingsPaths {
	/** Global settings are the base; project settings may only apply the documented overrides. */
	readonly globalPath: string;
	/** Project settings are intentionally read fresh for each lifecycle start. */
	readonly projectPath: string;
}

/** Historian is an optional producer inside an otherwise active MCTX runtime. */
export type MctxHistorianConfiguration =
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string }
	| { readonly kind: "enabled"; readonly model: string };

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
	readonly historian: MctxHistorianConfiguration;
	readonly failClosedBlocking: boolean;
	readonly executeThresholdPercentage: MctxThreshold;
	readonly executeThresholdTokens?: MctxOptionalThreshold;
	readonly protectedTags: number;
}

/** User-owned optional primer path. Project settings cannot select local files to search. */
export interface MctxSearchSettings {
	readonly primerPath?: string;
}

/**
 * User-owned embedding provider selection. Project settings cannot choose a
 * provider because it may point at a local model cache or an external
 * connection file; detailed runtime validation belongs to `pi-ext-embed`.
 */
export interface MctxEmbeddingSettings {
	/** Raw user-level config forwarded to `acquireEmbeddingProvider`. */
	readonly config: Readonly<Record<string, unknown>>;
}

export interface MctxDreamerSettings {
	/** User-owned Dreamer child model ref (exact provider/model). */
	readonly model?: string;
}

export type MctxPipelineState =
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly reason: string }
	| { readonly kind: "enabled"; readonly settings: MctxPipelineSettings };

/**
 * Raw settings are retained for diagnostics and future fields. `pipeline` is
 * the only normalized, runtime-authorized subset used by this milestone.
 */
export interface MctxConfiguration {
	/** Raw scopes remain available for diagnostics; `pipeline` is the validated runtime view. */
	readonly global: Readonly<Record<string, unknown>>;
	readonly project: Readonly<Record<string, unknown>>;
	readonly merged: Readonly<Record<string, unknown>>;
	sourceOf(path: readonly string[]): JsonSettingsValueSource | undefined;
	readonly pipeline: MctxPipelineState;
	readonly search?: MctxSearchSettings;
	readonly embedding?: MctxEmbeddingSettings;
	readonly dreamer?: MctxDreamerSettings;
	readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSearchSettings(
	global: Readonly<Record<string, unknown>>,
	project: Readonly<Record<string, unknown>>,
	warnings: string[],
): MctxSearchSettings | undefined {
	if (project.search !== undefined)
		warnings.push("Ignoring project search: primer selection is user-level only");
	const search = global.search;
	if (search === undefined) return undefined;
	if (!isRecord(search)) {
		warnings.push("Ignoring user search: must be an object");
		return undefined;
	}
	const primerPath = search.primer_path;
	if (primerPath === undefined) return undefined;
	if (
		typeof primerPath !== "string" ||
		!primerPath.trim() ||
		isAbsolute(primerPath) ||
		primerPath.split(/[\\/]+/u).some((part) => part === "..")
	) {
		warnings.push("Ignoring user search.primer_path: must be a project-relative path");
		return undefined;
	}
	return { primerPath };
}

function parseEmbeddingSettings(
	global: Readonly<Record<string, unknown>>,
	project: Readonly<Record<string, unknown>>,
	warnings: string[],
): MctxEmbeddingSettings | undefined {
	if (project.embedding !== undefined)
		warnings.push("Ignoring project embedding: provider selection is user-level only");
	const embedding = global.embedding;
	if (embedding === undefined) return undefined;
	if (!isRecord(embedding)) {
		warnings.push("Ignoring user embedding: must be an object");
		return undefined;
	}
	return { config: embedding };
}

function parseDreamerSettings(
	global: Readonly<Record<string, unknown>>,
	project: Readonly<Record<string, unknown>>,
	warnings: string[],
): MctxDreamerSettings | undefined {
	if (project.dreamer !== undefined)
		warnings.push("Ignoring project dreamer: model selection is user-level only");
	const dreamer = global.dreamer;
	if (dreamer === undefined) return undefined;
	if (!isRecord(dreamer)) {
		warnings.push("Ignoring user dreamer: must be an object");
		return undefined;
	}
	const model = dreamer.model;
	if (model !== undefined && (typeof model !== "string" || !validModelRef(model))) {
		warnings.push("Ignoring user dreamer.model: must be exact provider/model");
		return undefined;
	}
	return typeof model === "string" ? { model: model.trim() } : {};
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
	// Project settings may reduce MCTX work, never make it trigger earlier than
	// the user-level policy selected for this machine.
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
	// Global enablement is an explicit user opt-in. A repository may opt out, but
	// cannot silently activate model use for another developer's machine.
	if (global.enabled !== true || project.enabled === false) return { kind: "disabled" };
	if (project.enabled === true)
		warnings.push("Ignoring project enabled: only user config can enable pi-mctx");

	// Historian model and failure policy are user-only because both select local
	// credentials and alter whether a storage failure may block a parent session.
	const historian = global.historian;
	const historianConfiguration: MctxHistorianConfiguration = !isRecord(historian)
		? historian === undefined
			? { kind: "disabled" }
			: { kind: "invalid", reason: "historian must be an object" }
		: historian.enabled !== true
			? historian.enabled === undefined || typeof historian.enabled === "boolean"
				? { kind: "disabled" }
				: { kind: "invalid", reason: "historian.enabled must be boolean" }
			: typeof historian.model !== "string" || !validModelRef(historian.model)
				? { kind: "invalid", reason: "historian.model must be exact provider/model" }
				: { kind: "enabled", model: historian.model.trim() };

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
	// Project thresholds are a one-way safety override. `projectThreshold` drops
	// lower values rather than merging them as generic project-wins settings.
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
	const rawProtectedTags = global.protected_tags;
	const protectedTags = rawProtectedTags === undefined ? DEFAULT_PROTECTED_TAGS : rawProtectedTags;
	if (
		typeof protectedTags !== "number" ||
		!Number.isSafeInteger(protectedTags) ||
		protectedTags < MIN_PROTECTED_TAGS ||
		protectedTags > MAX_PROTECTED_TAGS
	) {
		return { kind: "invalid", reason: "protected_tags must be an integer between 1 and 100" };
	}
	if (project.protected_tags !== undefined) {
		warnings.push("Ignoring project protected_tags: only user config controls history protection");
	}

	return {
		kind: "enabled",
		settings: {
			historian: historianConfiguration,
			failClosedBlocking:
				failClosedBlocking === undefined ? DEFAULT_FAIL_CLOSED_BLOCKING : failClosedBlocking,
			executeThresholdPercentage: {
				defaultValue: raisedPercentage.defaultValue,
				byModel: raisedPercentage.byModel,
			},
			...(raisedTokens === undefined ? {} : { executeThresholdTokens: raisedTokens }),
			protectedTags,
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
	const search = parseSearchSettings(global, project, warnings);
	const embedding = parseEmbeddingSettings(global, project, warnings);
	const dreamer = parseDreamerSettings(global, project, warnings);
	return {
		global,
		project,
		merged: settings.merged,
		sourceOf: settings.sourceOf,
		pipeline: resolvePipeline(global, project, warnings),
		...(search === undefined ? {} : { search }),
		...(embedding === undefined ? {} : { embedding }),
		...(dreamer === undefined ? {} : { dreamer }),
		warnings,
	};
}
