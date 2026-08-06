import {
	defaultPiSettingsPaths,
	type JsonSettingsValueSource,
	readMergedJsonSettingsSection,
} from "@hheei/pi-ext-core";
import { validModelRef } from "./model-ref.js";

export const MCTX_SETTINGS_SECTION = "pi-mctx";
export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
export const DEFAULT_FAIL_CLOSED_BLOCKING = true;
export const DEFAULT_CLEAR_REASONING_AGE = 50;
export const DEFAULT_PROTECTED_TAGS = 20;
export const DEFAULT_SMART_DROPS = false;
export const DEFAULT_KNOWLEDGE_PERSISTENCE = "persistent" as const;
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;

const MIN_EXECUTE_THRESHOLD_PERCENTAGE = 20;
const MAX_EXECUTE_THRESHOLD_PERCENTAGE = 80;
const MIN_EXECUTE_THRESHOLD_TOKENS = 5_000;
const MAX_EXECUTE_THRESHOLD_TOKENS = 2_000_000;
const MIN_PROTECTED_TAGS = 1;
const MAX_PROTECTED_TAGS = 100;
const MIN_CLEAR_REASONING_AGE = 1;
const MAX_CLEAR_REASONING_AGE = 10_000;

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

export type MctxKnowledgePersistence = "persistent" | "ephemeral" | "disabled";

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
	/** User-owned privacy policy for Hindsight-derived knowledge copies. */
	readonly knowledgePersistence: MctxKnowledgePersistence;
	readonly failClosedBlocking: boolean;
	/** User-owned opt-in for automatic old tool-result reclaim. */
	readonly smartDrops: boolean;
	/** Model-visible elapsed-time comments; enabled unless the user explicitly disables them. */
	readonly temporalAwareness?: boolean;
	readonly executeThresholdPercentage: MctxThreshold;
	readonly executeThresholdTokens?: MctxOptionalThreshold;
	readonly protectedTags: number;
	/** Number of newest tags that retain assistant reasoning. */
	readonly clearReasoningAge: number;
	/** Lossy old-text compression is opt-in and never project-controlled. */
	readonly cavemanTextCompression?: { readonly minChars: number };
	/** User-owned cache maintenance delay, selected by the current parent model. */
	readonly cacheTtlMs?: MctxThreshold;
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
	readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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

function parseCacheTtlValue(value: unknown): number | undefined {
	if (typeof value === "number")
		return Number.isSafeInteger(value) && value > 0 ? value : undefined;
	if (typeof value !== "string") return undefined;
	const match = value.trim().match(/^(\d+)([smh])?$/u);
	if (match === null) return undefined;
	const quantity = Number(match[1]);
	const unit = match[2];
	const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 1;
	const milliseconds = quantity * multiplier;
	return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function parseCacheTtl(
	global: Readonly<Record<string, unknown>>,
	project: Readonly<Record<string, unknown>>,
	warnings: string[],
): MctxThreshold | undefined {
	if (project.cache_ttl !== undefined)
		warnings.push("Ignoring project cache_ttl: only user config controls cache policy");
	const raw = global.cache_ttl;
	if (raw === undefined) return undefined;
	const scalar = parseCacheTtlValue(raw);
	if (scalar !== undefined) return { defaultValue: scalar, byModel: {} };
	if (!isRecord(raw)) {
		warnings.push("Ignoring user cache_ttl: expected positive milliseconds or Ns/Nm/Nh");
		return undefined;
	}
	const byModel: Record<string, number> = {};
	const rawDefault = raw.default;
	const parsedDefault =
		rawDefault === undefined ? DEFAULT_CACHE_TTL_MS : parseCacheTtlValue(rawDefault);
	if (parsedDefault === undefined)
		warnings.push("Ignoring user cache_ttl.default: expected positive milliseconds or Ns/Nm/Nh");
	for (const [model, value] of Object.entries(raw)) {
		if (model === "default") continue;
		const parsed = parseCacheTtlValue(value);
		if (parsed === undefined) {
			warnings.push(`Ignoring user cache_ttl.${model}: expected positive milliseconds or Ns/Nm/Nh`);
			continue;
		}
		byModel[model] = parsed;
	}
	if (parsedDefault === undefined && Object.keys(byModel).length === 0) return undefined;
	return { defaultValue: parsedDefault ?? DEFAULT_CACHE_TTL_MS, byModel };
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

	const rawKnowledge = global.knowledge;
	let knowledgePersistence: MctxKnowledgePersistence = DEFAULT_KNOWLEDGE_PERSISTENCE;
	if (rawKnowledge !== undefined) {
		if (!isRecord(rawKnowledge)) return { kind: "invalid", reason: "knowledge must be an object" };
		const persistence = rawKnowledge.persistence;
		if (
			persistence !== undefined &&
			persistence !== "persistent" &&
			persistence !== "ephemeral" &&
			persistence !== "disabled"
		)
			return {
				kind: "invalid",
				reason: "knowledge.persistence must be persistent, ephemeral, or disabled",
			};
		if (persistence !== undefined) knowledgePersistence = persistence;
	}
	if (project.knowledge !== undefined)
		warnings.push("Ignoring project knowledge: only user config controls knowledge privacy");

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
	const rawSmartDrops = global.smart_drops;
	const smartDrops = rawSmartDrops === undefined ? DEFAULT_SMART_DROPS : rawSmartDrops;
	if (typeof smartDrops !== "boolean")
		return { kind: "invalid", reason: "smart_drops must be boolean" };
	if (project.smart_drops !== undefined) {
		warnings.push("Ignoring project smart_drops: only user config controls automatic reclaim");
	}
	const rawClearReasoningAge = global.clear_reasoning_age;
	const clearReasoningAge =
		rawClearReasoningAge === undefined ? DEFAULT_CLEAR_REASONING_AGE : rawClearReasoningAge;
	if (
		typeof clearReasoningAge !== "number" ||
		!Number.isSafeInteger(clearReasoningAge) ||
		clearReasoningAge < MIN_CLEAR_REASONING_AGE ||
		clearReasoningAge > MAX_CLEAR_REASONING_AGE
	) {
		return {
			kind: "invalid",
			reason: "clear_reasoning_age must be an integer between 1 and 10000",
		};
	}
	if (project.clear_reasoning_age !== undefined) {
		warnings.push(
			"Ignoring project clear_reasoning_age: only user config controls reasoning cleanup",
		);
	}
	const temporalAwareness = global.temporal_awareness ?? true;
	if (typeof temporalAwareness !== "boolean")
		return { kind: "invalid", reason: "temporal_awareness must be boolean" };
	if (project.temporal_awareness !== undefined) {
		warnings.push(
			"Ignoring project temporal_awareness: only user config controls temporal markers",
		);
	}
	if (project.caveman_text_compression !== undefined)
		warnings.push(
			"Ignoring project caveman_text_compression: only user config controls lossy history compression",
		);
	const rawCaveman = global.caveman_text_compression;
	let cavemanTextCompression: { readonly minChars: number } | undefined;
	if (rawCaveman !== undefined) {
		if (!isRecord(rawCaveman) || typeof rawCaveman.enabled !== "boolean")
			return { kind: "invalid", reason: "caveman_text_compression.enabled must be boolean" };
		const minChars = rawCaveman.min_chars === undefined ? 500 : rawCaveman.min_chars;
		if (
			typeof minChars !== "number" ||
			!Number.isSafeInteger(minChars) ||
			minChars < 100 ||
			minChars > 10_000
		)
			return {
				kind: "invalid",
				reason: "caveman_text_compression.min_chars must be an integer between 100 and 10000",
			};
		if (rawCaveman.enabled) cavemanTextCompression = { minChars };
	}
	const cacheTtlMs = parseCacheTtl(global, project, warnings);

	return {
		kind: "enabled",
		settings: {
			historian: historianConfiguration,
			knowledgePersistence,
			failClosedBlocking:
				failClosedBlocking === undefined ? DEFAULT_FAIL_CLOSED_BLOCKING : failClosedBlocking,
			smartDrops,
			...(temporalAwareness === false ? { temporalAwareness: false } : {}),
			executeThresholdPercentage: {
				defaultValue: raisedPercentage.defaultValue,
				byModel: raisedPercentage.byModel,
			},
			...(raisedTokens === undefined ? {} : { executeThresholdTokens: raisedTokens }),
			protectedTags,
			clearReasoningAge,
			...(cavemanTextCompression === undefined ? {} : { cavemanTextCompression }),
			...(cacheTtlMs === undefined ? {} : { cacheTtlMs }),
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
