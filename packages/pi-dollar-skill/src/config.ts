import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { updateJsonSettingsRoot } from "@hheei/pi-basics";
import {
	DEFAULT_DOLLAR_SKILL_CONFIG,
	type DollarSkillConfig,
	MAX_DOLLAR_SKILL_SUGGESTIONS,
} from "./model.js";

const SECTION = "pi-basics";
export const DOLLAR_SKILL_SETTINGS_GROUP = "dollarSkillReferences";
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
	return join(settingsDirectory, "settings.json");
}

export async function loadDollarSkillConfig(
	settingsDirectory = getAgentDir(),
): Promise<DollarSkillConfig> {
	const root = await readRoot(dollarSkillSettingsPath(settingsDirectory));
	const section = root[SECTION];
	return normalizeDollarSkillConfig(
		isJsonObject(section) ? section[DOLLAR_SKILL_SETTINGS_GROUP] : undefined,
	);
}

export async function saveDollarSkillConfig(
	settingsDirectory: string,
	config: DollarSkillConfig,
): Promise<void> {
	const path = dollarSkillSettingsPath(settingsDirectory);
	await updateJsonSettingsRoot(path, (root) => {
		const existing = root[SECTION];
		const section = isJsonObject(existing) ? { ...existing } : {};
		section[DOLLAR_SKILL_SETTINGS_GROUP] = normalizeDollarSkillConfig(config);
		root[SECTION] = section;
	});
}
