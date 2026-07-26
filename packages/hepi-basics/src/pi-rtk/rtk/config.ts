import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { updateJsonSettingsRoot } from "../../pi-basics/index.js";
import { normalizeRtkIntegrationConfig } from "./config-store.js";
import { DEFAULT_RTK_INTEGRATION_CONFIG, type RtkIntegrationConfig } from "./types.js";

type Json = Record<string, unknown>;
const SECTION = "pi-basics";
const GROUP = "rtk";

async function readRoot(path: string): Promise<Json> {
	try {
		const value = JSON.parse(await readFile(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export function settingsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "settings.json");
}
export async function loadRtkConfig(
	agentDir: string = getAgentDir(),
): Promise<{ config: RtkIntegrationConfig; warning?: string }> {
	try {
		const root = await readRoot(settingsPath(agentDir));
		const section = root[SECTION];
		const value =
			section && typeof section === "object" && !Array.isArray(section)
				? (section as Json)[GROUP]
				: undefined;
		if (value !== undefined) return { config: normalizeRtkIntegrationConfig(value) };
		return { config: structuredClone(DEFAULT_RTK_INTEGRATION_CONFIG) };
	} catch (error) {
		return {
			config: structuredClone(DEFAULT_RTK_INTEGRATION_CONFIG),
			warning: `Unable to load RTK settings: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
export async function saveRtkConfig(
	config: RtkIntegrationConfig,
	agentDir: string = getAgentDir(),
): Promise<void> {
	const path = settingsPath(agentDir);
	await updateJsonSettingsRoot(path, (root) => {
		const prior = root[SECTION];
		const section =
			prior && typeof prior === "object" && !Array.isArray(prior) ? { ...(prior as Json) } : {};
		section[GROUP] = normalizeRtkIntegrationConfig(config);
		root[SECTION] = section;
	});
}
