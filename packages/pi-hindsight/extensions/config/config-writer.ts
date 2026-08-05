import { defaultPiSettingsPaths, updateJsonSettingsRoot } from "@hheei/pi-ext-core";
import {
	HINDSIGHT_SETTINGS_SECTION,
	readGlobalSettingsConfig,
	readProjectSettingsConfig,
	validEnvVarName,
} from "./config.js";
import { type ConfigResetKey, resetPathsForConfigKeys } from "./config-field-paths.js";

export type MemoryProfile = "project-only" | "project+global" | "global-only" | "recall-only";

export type ConfigScope = "project" | "global";

export type ConfigSource = ConfigScope | "env" | "default";
export type { ConfigResetKey } from "./config-field-paths.js";

export const DEFAULT_GLOBAL_BANK_ID = "pi-global";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeBankPatch(
	patch: Record<string, unknown>,
	bank: "project" | "user",
	values: Record<string, unknown>,
): void {
	const banksPatch = isRecord(patch.banks) ? patch.banks : {};
	patch.banks = {
		...banksPatch,
		[bank]: {
			...(isRecord(banksPatch[bank]) ? banksPatch[bank] : {}),
			...values,
		},
	};
}

export function projectConfigPath(cwd: string): string {
	return defaultPiSettingsPaths(cwd).projectPath;
}

export function globalConfigPath(agentDir?: string): string {
	return defaultPiSettingsPaths(undefined, agentDir).globalPath;
}

export function readProjectConfig(cwd: string): Record<string, unknown> {
	return readProjectSettingsConfig(cwd);
}

export function readGlobalConfig(agentDir?: string): Record<string, unknown> {
	return readGlobalSettingsConfig(agentDir);
}

export function deepMergeConfig(
	base: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		out[key] = isRecord(value) && isRecord(out[key]) ? deepMergeConfig(out[key], value) : value;
	}
	return out;
}

export interface ProjectConfigPatchInput {
	enabled?: boolean;
	setupComplete?: boolean;
	scopeMode?: "domain-tagged" | "isolated-bank";
	projectId?: string;
	projectIdStrategy?: "remote" | "basename";
	/** Opt-in shared/untagged observation recall (ADR-005 / #492). */
	includeSharedObservations?: boolean;
	baseUrl?: string;
	timeoutMs?: number;
	apiKeyEnvVar?: string;
	directApiKey?: string;
	projectBankId?: string;
	projectRetainMission?: string;
	projectReflectMission?: string;
	projectObservationsMission?: string;
	globalBankId?: string;
	globalRetainMission?: string;
	globalReflectMission?: string;
	globalObservationsMission?: string;
	globalRetainMode?: "explicit-only";
	enableGlobalBank?: boolean;
	memoryProfile?: MemoryProfile;
	agentUse?: "coding" | "conversation";
	mentalModelsInject?: boolean;
	recallEnabled?: boolean;
	recallBudget?: "low" | "mid" | "high";
	recallMaxTokens?: number;
	recallUserMaxTokens?: number;
	recallStoreLast?: boolean;
	recallStoreFailures?: boolean;
	recallPreferObservations?: boolean;
	retainEnabled?: boolean;
	retainAsync?: boolean;
	retainDelivery?: "immediate" | "coalesced";
	retainUpdateMode?: "append" | "replace";
	queuePath?: string;
	importMode?: "curated" | "raw" | "forensic";
	importQualityProfile?: "compatible" | "strict";
	importIncludeBranches?: "current-only" | "all-leaves";
	importToolResults?: "errors-only" | "summary" | "content";
	importToolResultSummaryMaxChars?: number;
	importManifestPath?: string;
	importCheckpointPath?: string;
	importReplaceExistingDocs?: boolean;
	importResume?: boolean;
	statusStyle?: "off" | "text" | "emoji" | "nerdfont";
	statusDetail?: "minimal" | "project" | "activity" | "verbose";
	statusMaxLength?: number;
	statusShowActivity?: boolean;
	notifyStartup?: boolean;
	notifyRecall?: boolean;
	notifyRetain?: boolean;
	resetDefaults?: ConfigResetKey[];
	scope?: ConfigScope;
}

export function buildProjectConfigDeletes(input: ProjectConfigPatchInput): string[][] {
	return resetPathsForConfigKeys(input.resetDefaults ?? []);
}

export function buildProjectConfigPatch(input: ProjectConfigPatchInput): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	if (input.enabled !== undefined) patch.enabled = input.enabled;
	if (input.setupComplete !== undefined) patch.setupComplete = input.setupComplete;
	if (
		input.scopeMode !== undefined ||
		input.projectId !== undefined ||
		input.projectIdStrategy !== undefined ||
		input.includeSharedObservations !== undefined
	) {
		patch.scope = {
			...(input.scopeMode !== undefined ? { mode: input.scopeMode } : {}),
			...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
			...(input.projectIdStrategy !== undefined
				? { projectIdStrategy: input.projectIdStrategy }
				: {}),
			...(input.includeSharedObservations !== undefined
				? { includeSharedObservations: input.includeSharedObservations }
				: {}),
		};
	}
	if (input.apiKeyEnvVar && !validEnvVarName(input.apiKeyEnvVar)) {
		throw new Error("apiKeyEnvVar must be an environment variable name");
	}
	if (input.directApiKey && input.scope !== "global") {
		throw new Error(
			"directApiKey can only be written to user config; use apiKeyEnvVar for project config",
		);
	}
	if (input.baseUrl || input.timeoutMs !== undefined || input.apiKeyEnvVar || input.directApiKey) {
		patch.hindsight = {
			...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
			...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
			...(input.apiKeyEnvVar ? { apiKey: { source: "env", name: input.apiKeyEnvVar } } : {}),
			...(input.directApiKey ? { apiKey: input.directApiKey } : {}),
		};
	}
	if (input.agentUse) {
		patch.agentUse = input.agentUse;
	}
	if (input.mentalModelsInject !== undefined) {
		patch.mentalModels = { inject: input.mentalModelsInject };
	}
	if (input.memoryProfile) {
		const globalBankId = input.globalBankId?.trim();
		const userBankPatch = { enabled: true, ...(globalBankId ? { bankId: globalBankId } : {}) };
		if (input.memoryProfile === "project-only") {
			patch.banks = { project: { enabled: true }, user: { enabled: false } };
			patch.userRetain = { mode: "explicit-only" };
			patch.recall = { enabled: true };
			patch.retain = { enabled: true };
		} else if (input.memoryProfile === "project+global") {
			patch.banks = {
				project: { enabled: true },
				user: userBankPatch,
			};
			patch.userRetain = { mode: "explicit-only" };
			patch.recall = { enabled: true };
			patch.retain = { enabled: true };
		} else if (input.memoryProfile === "global-only") {
			patch.banks = {
				project: { enabled: false },
				user: userBankPatch,
			};
			patch.userRetain = { mode: "explicit-only" };
			patch.recall = { enabled: true };
			patch.retain = { enabled: true };
		} else {
			patch.recall = { enabled: true };
			patch.retain = { enabled: false };
		}
	}
	if (input.projectBankId && input.memoryProfile !== "global-only") {
		patch.banks = {
			...(isRecord(patch.banks) ? patch.banks : {}),
			project: { enabled: true, derive: "manual", bankId: input.projectBankId },
		};
	}
	if (input.projectRetainMission !== undefined) {
		mergeBankPatch(patch, "project", { retainMission: input.projectRetainMission });
	}
	if (input.projectReflectMission !== undefined) {
		mergeBankPatch(patch, "project", { reflectMission: input.projectReflectMission });
	}
	if (input.projectObservationsMission !== undefined) {
		mergeBankPatch(patch, "project", { observationsMission: input.projectObservationsMission });
	}
	if (!input.memoryProfile && (input.globalBankId || input.enableGlobalBank !== undefined)) {
		patch.banks = {
			...(isRecord(patch.banks) ? patch.banks : {}),
			user: {
				...(input.enableGlobalBank !== undefined ? { enabled: input.enableGlobalBank } : {}),
				...(input.globalBankId ? { bankId: input.globalBankId, enabled: true } : {}),
			},
		};
	}
	if (input.globalRetainMission !== undefined) {
		mergeBankPatch(patch, "user", { retainMission: input.globalRetainMission });
	}
	if (input.globalReflectMission !== undefined) {
		mergeBankPatch(patch, "user", { reflectMission: input.globalReflectMission });
	}
	if (input.globalObservationsMission !== undefined) {
		mergeBankPatch(patch, "user", { observationsMission: input.globalObservationsMission });
	}
	if (input.globalRetainMode) {
		patch.userRetain = { mode: input.globalRetainMode };
	}
	if (
		input.recallEnabled !== undefined ||
		input.recallBudget ||
		input.recallMaxTokens !== undefined ||
		input.recallUserMaxTokens !== undefined ||
		input.recallStoreLast !== undefined ||
		input.recallStoreFailures !== undefined ||
		input.recallPreferObservations !== undefined
	) {
		patch.recall = {
			...(input.recallEnabled !== undefined ? { enabled: input.recallEnabled } : {}),
			...(input.recallBudget ? { budget: input.recallBudget } : {}),
			...(input.recallMaxTokens !== undefined ? { maxTokens: input.recallMaxTokens } : {}),
			...(input.recallUserMaxTokens !== undefined
				? { userMaxTokens: input.recallUserMaxTokens }
				: {}),
			...(input.recallStoreLast !== undefined ? { storeLastRecall: input.recallStoreLast } : {}),
			...(input.recallStoreFailures !== undefined
				? { storeLastRecallFailures: input.recallStoreFailures }
				: {}),
			...(input.recallPreferObservations !== undefined
				? { preferObservations: input.recallPreferObservations }
				: {}),
		};
	}
	if (
		input.queuePath ||
		input.retainEnabled !== undefined ||
		input.retainAsync !== undefined ||
		input.retainDelivery ||
		input.retainUpdateMode
	) {
		patch.retain = {
			...(input.retainEnabled !== undefined ? { enabled: input.retainEnabled } : {}),
			...(input.retainAsync !== undefined ? { async: input.retainAsync } : {}),
			...(input.retainDelivery ? { delivery: input.retainDelivery } : {}),
			...(input.retainUpdateMode ? { updateMode: input.retainUpdateMode } : {}),
			...(input.queuePath ? { queuePath: input.queuePath } : {}),
		};
	}
	if (
		input.importMode ||
		input.importQualityProfile ||
		input.importIncludeBranches ||
		input.importToolResults ||
		input.importToolResultSummaryMaxChars !== undefined ||
		input.importManifestPath ||
		input.importCheckpointPath ||
		input.importReplaceExistingDocs !== undefined ||
		input.importResume !== undefined
	) {
		patch.import = {
			...(input.importMode ? { mode: input.importMode } : {}),
			...(input.importQualityProfile ? { qualityProfile: input.importQualityProfile } : {}),
			...(input.importIncludeBranches ? { includeBranches: input.importIncludeBranches } : {}),
			...(input.importToolResults ? { toolResults: input.importToolResults } : {}),
			...(input.importToolResultSummaryMaxChars !== undefined
				? { toolResultSummaryMaxChars: input.importToolResultSummaryMaxChars }
				: {}),
			...(input.importManifestPath ? { manifestPath: input.importManifestPath } : {}),
			...(input.importCheckpointPath ? { checkpointPath: input.importCheckpointPath } : {}),
			...(input.importReplaceExistingDocs !== undefined
				? { replaceExistingImportedDocs: input.importReplaceExistingDocs }
				: {}),
			...(input.importResume !== undefined ? { resume: input.importResume } : {}),
		};
	}
	if (
		input.statusStyle ||
		input.statusDetail ||
		input.statusMaxLength !== undefined ||
		input.statusShowActivity !== undefined
	) {
		patch.status = {
			...(input.statusStyle ? { style: input.statusStyle } : {}),
			...(input.statusDetail ? { detail: input.statusDetail } : {}),
			...(input.statusMaxLength !== undefined ? { maxLength: input.statusMaxLength } : {}),
			...(input.statusShowActivity !== undefined ? { showActivity: input.statusShowActivity } : {}),
		};
	}
	if (
		input.notifyStartup !== undefined ||
		input.notifyRecall !== undefined ||
		input.notifyRetain !== undefined
	) {
		patch.notifications = {
			...(input.notifyStartup !== undefined ? { startup: input.notifyStartup } : {}),
			...(input.notifyRecall !== undefined ? { recall: input.notifyRecall } : {}),
			...(input.notifyRetain !== undefined ? { retain: input.notifyRetain } : {}),
		};
	}
	return patch;
}

function deletePath(config: Record<string, unknown>, path: string[]): void {
	const [head, ...rest] = path;
	if (!head) return;
	if (rest.length === 0) {
		delete config[head];
		return;
	}
	const child = config[head];
	if (isRecord(child)) deletePath(child, rest);
}

async function writeConfig(
	path: string,
	patch: Record<string, unknown>,
	deletePaths: string[][] = [],
): Promise<{ path: string; config: Record<string, unknown> }> {
	let next: Record<string, unknown> = {};
	await updateJsonSettingsRoot(path, (root) => {
		const current = root[HINDSIGHT_SETTINGS_SECTION];
		if (current !== undefined && !isRecord(current)) {
			throw new Error(`${HINDSIGHT_SETTINGS_SECTION} in ${path} must be an object`);
		}
		const base = current ?? {};
		for (const deletePathParts of deletePaths) deletePath(base, deletePathParts);
		next = deepMergeConfig(base, patch);
		root[HINDSIGHT_SETTINGS_SECTION] = next;
	});
	return { path, config: next };
}

export async function writeProjectConfig(
	cwd: string,
	patch: Record<string, unknown>,
	deletePaths: string[][] = [],
): Promise<{ path: string; config: Record<string, unknown> }> {
	return writeConfig(projectConfigPath(cwd), patch, deletePaths);
}

export async function writeGlobalConfig(
	patch: Record<string, unknown>,
	deletePaths: string[][] = [],
	agentDir?: string,
): Promise<{ path: string; config: Record<string, unknown> }> {
	return writeConfig(globalConfigPath(agentDir), patch, deletePaths);
}

export type ConfigOperationDeps = {
	getProjectBankId(): string;
	reloadConfig?(cwd: string): void;
};

export async function configureMemory(
	cwd: string,
	args: ProjectConfigPatchInput,
	deps: ConfigOperationDeps,
): Promise<{ path: string; config: Record<string, unknown>; projectBankId: string }> {
	const projectBankId = args.projectBankId || deps.getProjectBankId();
	const patch = buildProjectConfigPatch(args);
	const deletes = buildProjectConfigDeletes(args);
	const result =
		args.scope === "global"
			? await writeGlobalConfig(patch, deletes)
			: await writeProjectConfig(cwd, patch, deletes);
	deps.reloadConfig?.(cwd);
	return { projectBankId, ...result };
}

export async function initMemoryConfig(
	cwd: string,
	deps: Pick<ConfigOperationDeps, "getProjectBankId"> & {
		getConfig(): { hindsight: { baseUrl: string } };
	},
): Promise<{ path: string; config: Record<string, unknown>; projectBankId: string }> {
	const projectBankId = deps.getProjectBankId();
	const result = await writeProjectConfig(
		cwd,
		buildProjectConfigPatch({
			projectBankId,
			baseUrl: deps.getConfig().hindsight.baseUrl,
		}),
	);
	return { projectBankId, ...result };
}
