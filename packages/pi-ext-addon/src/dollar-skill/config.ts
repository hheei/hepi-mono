import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { updateJsonSettingsRoot } from "@hheei/pi-ext-core";
import {
	DEFAULT_DOLLAR_SKILL_CONFIG,
	type DollarSkillConfig,
	MAX_DOLLAR_SKILL_SUGGESTIONS,
} from "./model.js";

const GROUP = "dollar-skill";
const LEGACY_GROUP = "pi-dollar-skill";
export const DOLLAR_SKILL_SETTINGS_GROUP = GROUP;
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeMaxSuggestions(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value))
		return DEFAULT_DOLLAR_SKILL_CONFIG.maxSuggestions;
	return Math.max(1, Math.min(MAX_DOLLAR_SKILL_SUGGESTIONS, value));
}

export function normalizeDollarSkillConfig(value: unknown): DollarSkillConfig {
	if (!isJsonObject(value)) return DEFAULT_DOLLAR_SKILL_CONFIG;
	return {
		enabled:
			typeof value.enabled === "boolean" ? value.enabled : DEFAULT_DOLLAR_SKILL_CONFIG.enabled,
		maxSuggestions: normalizeMaxSuggestions(value.maxSuggestions),
	};
}

async function readRoot(path: string): Promise<JsonObject> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isJsonObject(parsed) ? parsed : {};
	} catch (error) {
		if (isJsonObject(error) && error.code === "ENOENT") return {};
		throw error;
	}
}

export function dollarSkillSettingsPath(settingsDirectory = getAgentDir()): string {
	return join(settingsDirectory, "ext_settings.json");
}

export async function loadDollarSkillConfig(
	settingsDirectory = getAgentDir(),
): Promise<DollarSkillConfig> {
	const root = await readRoot(dollarSkillSettingsPath(settingsDirectory));
	const group = root[GROUP] ?? root[LEGACY_GROUP];
	return normalizeDollarSkillConfig(group);
}

export async function saveDollarSkillConfig(
	settingsDirectory: string,
	config: DollarSkillConfig,
): Promise<void> {
	const path = dollarSkillSettingsPath(settingsDirectory);
	await updateJsonSettingsRoot(path, (root) => {
		const existing = root[GROUP];
		const group = isJsonObject(existing) ? { ...existing } : {};
		root[GROUP] = { ...group, ...normalizeDollarSkillConfig(config) };
	});
}
