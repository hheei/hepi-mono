import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export function settingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}
export async function loadRtkConfig(
	cwd: string,
): Promise<{ config: RtkIntegrationConfig; warning?: string }> {
	try {
		const root = await readRoot(settingsPath(cwd));
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
export async function saveRtkConfig(cwd: string, config: RtkIntegrationConfig): Promise<void> {
	const path = settingsPath(cwd);
	const root = await readRoot(path);
	const prior = root[SECTION];
	const section =
		prior && typeof prior === "object" && !Array.isArray(prior) ? { ...(prior as Json) } : {};
	section[GROUP] = normalizeRtkIntegrationConfig(config);
	root[SECTION] = section;
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.rtk.tmp`;
	await writeFile(tmp, `${JSON.stringify(root, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}
