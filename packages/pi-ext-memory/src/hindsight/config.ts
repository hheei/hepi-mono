import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	defaultExtensionSettingsPaths,
	errorMessage,
	isRecord,
	readMergedJsonSettingsSection,
} from "@hheei/pi-ext-core";
import { debugLog } from "../debug-log.js";

/** Reflect reasoning budget forwarded to the Hindsight reflect endpoint. */
export type ReflectBudget = "low" | "mid" | "high";

/**
 * How the resolved bank relates to the current repository.
 *
 * - `dedicated-bank`: the bank was derived per repository (template or git-derived), so
 *   its contents belong to this repository alone and no extra scope tag is applied.
 * - `tagged-shared-bank`: the bank is shared (explicit, path-mapped, or the fallback
 *   file's static default), so every read and write carries a `repo:<name>` scope tag to
 *   keep repositories from contaminating each other.
 */
export type HindsightIsolationMode = "dedicated-bank" | "tagged-shared-bank";

/** Where the effective bank id came from; exposed by `hindsight_diagnose`. */
export type HindsightBankSource = "settings" | "path-map" | "template" | "fallback" | "derived";

export interface HindsightConfig {
	apiUrl: string;
	apiToken?: string | undefined;
	/**
	 * Inject knowledge-page hits for the current prompt before each turn.
	 *
	 * Retrieval only — deep reasoning stays an explicit `hindsight_reflect` tool call,
	 * because an agentic reflect call costs seconds and would block every turn.
	 */
	autoRecall: boolean;
	retainSessions: boolean;
	reflectBudget: ReflectBudget;
	reflectTimeoutMs: number;
	readTimeoutMs: number;
	maxMemoryChars: number;
	/** Path to the Hindsight fallback config file; `~` is expanded. */
	configPath: string;
}

export interface ResolvedHindsight {
	readonly config: HindsightConfig;
	readonly bankId: string;
	readonly bankSource: HindsightBankSource;
	readonly repo: string;
	readonly scopeTags: readonly string[];
	/** Tags applied to every retained turn: scope tags plus the bank's configured tags. */
	readonly retainTags: readonly string[];
	/** Metadata applied to every retained turn. */
	readonly retainMetadata: Readonly<Record<string, string>>;
	readonly isolationMode: HindsightIsolationMode;
}

export const HINDSIGHT_SETTINGS_KEY = "pi-ext-memory";
export const HINDSIGHT_SETTINGS_SECTION = "hindsight";
export const DEFAULT_HINDSIGHT_CONFIG_PATH = "~/.hindsight/coding-agent.json";
export const HINDSIGHT_REPO_TAG_PREFIX = "repo:";

export const HINDSIGHT_DEFAULTS: HindsightConfig = {
	apiUrl: "https://api.hindsight.vectorize.io",
	autoRecall: true,
	retainSessions: true,
	reflectBudget: "high",
	reflectTimeoutMs: 45_000,
	readTimeoutMs: 15_000,
	maxMemoryChars: 8_000,
	configPath: DEFAULT_HINDSIGHT_CONFIG_PATH,
};

const REFLECT_BUDGETS: readonly ReflectBudget[] = ["low", "mid", "high"];

/** Env var names consumed by the Hindsight layer, in decreasing precedence. */
export const HINDSIGHT_ENV = {
	apiUrl: "HINDSIGHT_API_URL",
	apiToken: "HINDSIGHT_API_TOKEN",
	bankId: "HINDSIGHT_BANK_ID",
	configPath: "HINDSIGHT_CONFIG",
} as const;

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return items.length === value.length ? items : undefined;
}

function stringRecordOrUndefined(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
	return entries.length === Object.keys(value).length ? Object.fromEntries(entries) : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function reflectBudgetOrUndefined(value: unknown): ReflectBudget | undefined {
	return typeof value === "string" && (REFLECT_BUDGETS as readonly string[]).includes(value)
		? (value as ReflectBudget)
		: undefined;
}

/** Expands a leading `~` and resolves relative paths against `cwd`. */
export function expandConfigPath(path: string, cwd: string): string {
	const expanded =
		path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Repository name used for derived bank ids and the `repo:` scope tag.
 *
 * Walks up from `cwd` looking for a `.git` entry — a directory for a normal checkout or a
 * gitdir file for a worktree — so every subdirectory of a checkout resolves to the same
 * name. Falls back to the directory basename outside a repository.
 */
export async function resolveRepoName(cwd: string): Promise<string> {
	let current = resolve(cwd);
	for (;;) {
		try {
			await stat(join(current, ".git"));
			return basename(current);
		} catch {
			// Not a repository root; keep walking up.
		}
		const parent = dirname(current);
		if (parent === current) return basename(resolve(cwd));
		current = parent;
	}
}

/** Longest-prefix path match against a `mapPathToBank` style record. */
function matchPathPrefix(
	map: Record<string, unknown>,
	cwd: string,
): { bankId: string; prefix: string } | undefined {
	const target = resolve(cwd);
	let best: { bankId: string; prefix: string } | undefined;
	for (const [prefix, value] of Object.entries(map)) {
		const bankId = nonEmptyString(value);
		if (bankId === undefined) continue;
		const resolvedPrefix = resolve(expandConfigPath(prefix, cwd));
		if (target !== resolvedPrefix && !target.startsWith(`${resolvedPrefix}/`)) continue;
		if (best === undefined || resolvedPrefix.length > best.prefix.length) {
			best = { bankId, prefix: resolvedPrefix };
		}
	}
	return best;
}

function resolveBank(
	settingsBankId: string | undefined,
	envBankId: string | undefined,
	fallback: Record<string, unknown> | undefined,
	cwd: string,
	repo: string,
): { bankId: string; source: HindsightBankSource } {
	if (settingsBankId !== undefined) return { bankId: settingsBankId, source: "settings" };
	if (envBankId !== undefined) return { bankId: envBankId, source: "settings" };
	const map = fallback?.mapPathToBank;
	if (isRecord(map)) {
		const match = matchPathPrefix(map, cwd);
		if (match !== undefined) return { bankId: match.bankId, source: "path-map" };
	}
	const template = nonEmptyString(fallback?.bankIdTemplate);
	if (template !== undefined) {
		return { bankId: template.replaceAll("{gitProject}", repo), source: "template" };
	}
	const fallbackBankId = nonEmptyString(fallback?.bankId);
	if (fallbackBankId !== undefined) return { bankId: fallbackBankId, source: "fallback" };
	return { bankId: `coding-agent::${repo}`, source: "derived" };
}

function bankOverrides(
	fallback: Record<string, unknown> | undefined,
	bankId: string,
): { retainTags: string[]; retainMetadata: Record<string, string> } {
	const bank = fallback?.banks;
	if (!isRecord(bank)) return { retainTags: [], retainMetadata: {} };
	const entry = bank[bankId];
	if (!isRecord(entry)) return { retainTags: [], retainMetadata: {} };
	return {
		retainTags: stringArrayOrUndefined(entry.retainTags) ?? [],
		retainMetadata: stringRecordOrUndefined(entry.retainMetadata) ?? {},
	};
}

/**
 * Merges the `pi-ext-memory.hindsight` settings section, environment variables, and an
 * already-parsed fallback config file into a resolved runtime view.
 *
 * Pure by design: every input is supplied by the caller, including `repo`, so the
 * precedence rules and bank routing stay unit-testable without touching the filesystem.
 * Returns `undefined` when the option is not explicitly enabled.
 */
export function resolveHindsightConfig(input: {
	settings: unknown;
	env: NodeJS.ProcessEnv;
	fallback: Record<string, unknown> | undefined;
	cwd: string;
	repo: string;
}): ResolvedHindsight | undefined {
	const settings = isRecord(input.settings) ? input.settings : {};
	if (settings.enabled !== true) return undefined;

	const fallback = input.fallback;
	const env = input.env;
	const config: HindsightConfig = {
		apiUrl:
			nonEmptyString(settings.apiUrl) ??
			nonEmptyString(env[HINDSIGHT_ENV.apiUrl]) ??
			nonEmptyString(fallback?.apiUrl) ??
			HINDSIGHT_DEFAULTS.apiUrl,
		autoRecall: booleanOrUndefined(settings.autoRecall) ?? HINDSIGHT_DEFAULTS.autoRecall,
		retainSessions:
			booleanOrUndefined(settings.retainSessions) ?? HINDSIGHT_DEFAULTS.retainSessions,
		reflectBudget:
			reflectBudgetOrUndefined(settings.reflectBudget) ?? HINDSIGHT_DEFAULTS.reflectBudget,
		reflectTimeoutMs:
			positiveIntegerOrUndefined(settings.reflectToolTimeoutMs) ??
			HINDSIGHT_DEFAULTS.reflectTimeoutMs,
		readTimeoutMs:
			positiveIntegerOrUndefined(settings.readTimeoutMs) ?? HINDSIGHT_DEFAULTS.readTimeoutMs,
		maxMemoryChars:
			positiveIntegerOrUndefined(settings.maxMemoryChars) ?? HINDSIGHT_DEFAULTS.maxMemoryChars,
		configPath:
			nonEmptyString(settings.configPath) ??
			nonEmptyString(env[HINDSIGHT_ENV.configPath]) ??
			HINDSIGHT_DEFAULTS.configPath,
	};
	const apiToken = nonEmptyString(settings.apiToken) ?? nonEmptyString(env[HINDSIGHT_ENV.apiToken]);
	if (apiToken !== undefined) config.apiToken = apiToken;

	const { bankId, source } = resolveBank(
		nonEmptyString(settings.bankId),
		nonEmptyString(env[HINDSIGHT_ENV.bankId]),
		fallback,
		input.cwd,
		input.repo,
	);
	const isolationMode: HindsightIsolationMode =
		source === "template" || source === "derived" ? "dedicated-bank" : "tagged-shared-bank";
	const scopeTags =
		isolationMode === "tagged-shared-bank" ? [`${HINDSIGHT_REPO_TAG_PREFIX}${input.repo}`] : [];
	const overrides = bankOverrides(fallback, bankId);
	const retainTags = [...new Set([...scopeTags, ...overrides.retainTags])];

	return {
		config,
		bankId,
		bankSource: source,
		repo: input.repo,
		scopeTags,
		retainTags,
		retainMetadata: { project: input.repo, cwd: input.cwd, ...overrides.retainMetadata },
		isolationMode,
	};
}

async function readFallbackConfig(path: string, signal?: AbortSignal): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, { encoding: "utf8", ...(signal ? { signal } : {}) });
	} catch {
		// A missing or unreadable fallback file is the normal case for native config.
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch (error) {
		debugLog("hindsight.config_fallback_invalid", {
			path,
			error: errorMessage(error),
		});
		return undefined;
	}
}

/**
 * Reads Hindsight configuration for `cwd`.
 *
 * Returns `undefined` — before reading any Hindsight-specific file — unless
 * `pi-ext-memory.hindsight.enabled` is literally `true`, so a disabled option costs one
 * settings read and nothing else.
 */
export async function loadHindsightConfig(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<ResolvedHindsight | undefined> {
	const merged = await readMergedJsonSettingsSection({
		paths: defaultExtensionSettingsPaths(cwd),
		section: HINDSIGHT_SETTINGS_KEY,
		...(signal ? { signal } : {}),
	});
	const section = merged.merged[HINDSIGHT_SETTINGS_SECTION];
	const settings = isRecord(section) ? section : {};
	if (settings.enabled !== true) return undefined;

	const fallbackPath = expandConfigPath(
		nonEmptyString(settings.configPath) ??
			nonEmptyString(env[HINDSIGHT_ENV.configPath]) ??
			HINDSIGHT_DEFAULTS.configPath,
		cwd,
	);
	const [rawFallback, repo] = await Promise.all([
		readFallbackConfig(fallbackPath, signal),
		resolveRepoName(cwd),
	]);
	return resolveHindsightConfig({
		settings,
		env,
		fallback: isRecord(rawFallback) ? rawFallback : undefined,
		cwd,
		repo,
	});
}
