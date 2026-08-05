import { toRecord } from "./record-utils.js";
import {
	DEFAULT_RTK_INTEGRATION_CONFIG,
	RTK_MODES,
	RTK_SOURCE_FILTER_LEVELS,
	type RtkIntegrationConfig,
	type RtkSourceFilterLevel,
} from "./types.js";

function toBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function toInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	const rounded = Math.round(value);
	return Math.max(min, Math.min(max, rounded));
}

function toMode(value: unknown): RtkIntegrationConfig["mode"] {
	return RTK_MODES.includes(value as RtkIntegrationConfig["mode"])
		? (value as RtkIntegrationConfig["mode"])
		: DEFAULT_RTK_INTEGRATION_CONFIG.mode;
}

function toSourceFilterLevel(value: unknown, fallback: RtkSourceFilterLevel): RtkSourceFilterLevel {
	return RTK_SOURCE_FILTER_LEVELS.includes(value as RtkSourceFilterLevel)
		? (value as RtkSourceFilterLevel)
		: fallback;
}

export function normalizeRtkIntegrationConfig(raw: unknown): RtkIntegrationConfig {
	const source = toRecord(raw);
	const outputCompactionSource = toRecord(source.outputCompaction);
	const readCompactionSource = toRecord(outputCompactionSource.readCompaction);
	const truncateSource = toRecord(outputCompactionSource.truncate);
	const smartTruncateSource = toRecord(outputCompactionSource.smartTruncate);
	return {
		enabled: toBoolean(source.enabled, DEFAULT_RTK_INTEGRATION_CONFIG.enabled),
		mode: toMode(source.mode),
		guardWhenRtkMissing: toBoolean(
			source.guardWhenRtkMissing,
			DEFAULT_RTK_INTEGRATION_CONFIG.guardWhenRtkMissing,
		),
		showRewriteNotifications: toBoolean(
			source.showRewriteNotifications,
			DEFAULT_RTK_INTEGRATION_CONFIG.showRewriteNotifications,
		),
		outputCompaction: {
			enabled: toBoolean(
				outputCompactionSource.enabled,
				DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.enabled,
			),
			stripAnsi: toBoolean(
				outputCompactionSource.stripAnsi,
				DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.stripAnsi,
			),
			readCompaction: {
				enabled: toBoolean(
					readCompactionSource.enabled,
					DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.readCompaction.enabled,
				),
			},
			sourceCodeFilteringEnabled: toBoolean(
				outputCompactionSource.sourceCodeFilteringEnabled,
				DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.sourceCodeFilteringEnabled,
			),
			preserveExactSkillReads: toBoolean(
				outputCompactionSource.preserveExactSkillReads,
				DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.preserveExactSkillReads,
			),
			truncate: {
				enabled: toBoolean(
					truncateSource.enabled,
					DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.truncate.enabled,
				),
				maxChars: toInteger(
					truncateSource.maxChars,
					DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.truncate.maxChars,
					1_000,
					200_000,
				),
			},
			sourceCodeFiltering: toSourceFilterLevel(
				outputCompactionSource.sourceCodeFiltering,
				DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.sourceCodeFiltering,
			),
			smartTruncate: {
				enabled: toBoolean(
					smartTruncateSource.enabled,
					DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.smartTruncate.enabled,
				),
				maxLines: toInteger(
					smartTruncateSource.maxLines,
					DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.smartTruncate.maxLines,
					40,
					4_000,
				),
			},
			aggregateTestOutput: toBoolean(
				outputCompactionSource.aggregateTestOutput,
				DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.aggregateTestOutput,
			),
			filterBuildOutput: toBoolean(
				outputCompactionSource.filterBuildOutput,
				DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.filterBuildOutput,
			),
			compactGitOutput: toBoolean(
				outputCompactionSource.compactGitOutput,
				DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.compactGitOutput,
			),
			aggregateLinterOutput: toBoolean(
				outputCompactionSource.aggregateLinterOutput,
				DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.aggregateLinterOutput,
			),
			groupSearchOutput: toBoolean(
				outputCompactionSource.groupSearchOutput,
				DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.groupSearchOutput,
			),
			trackSavings: toBoolean(
				outputCompactionSource.trackSavings,
				DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction.trackSavings,
			),
		},
	};
}
