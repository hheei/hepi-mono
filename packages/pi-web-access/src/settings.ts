import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	defaultExtensionSettingsPaths,
	isRecord,
	readJsonSettingsRoot,
	type SettingsProvider,
	type SettingValue,
	updateJsonSettingsRoot,
} from "@hheei/pi-ext-core";
import type { WebSearchConfig } from "./web-tool-core.ts";

export const WEB_SEARCH_SETTINGS_KEY = "webSearch";

export function getWebSearchSettingsPath(): string {
	return defaultExtensionSettingsPaths().globalPath;
}

export function getWebSearchConfigDir(): string {
	return dirname(getWebSearchSettingsPath());
}

function deepMergeSettings(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...target };
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (isRecord(value) && isRecord(result[key])) {
			result[key] = deepMergeSettings(result[key] as Record<string, unknown>, value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function isSettingValue(value: unknown): value is SettingValue {
	return (
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string" ||
		(Array.isArray(value) && value.every((item) => typeof item === "string"))
	);
}

export function readWebSearchSection(customPath?: string): Record<string, unknown> {
	const globalPath = customPath ?? getWebSearchSettingsPath();
	let globalSection: Record<string, unknown> = {};
	if (existsSync(globalPath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(globalPath, "utf8"));
			if (isRecord(parsed) && isRecord(parsed[WEB_SEARCH_SETTINGS_KEY])) {
				globalSection = parsed[WEB_SEARCH_SETTINGS_KEY];
			}
		} catch {
			// Ignore parse errors on disk reads; fall back to empty
		}
	}
	if (customPath === undefined) {
		const projectPath = defaultExtensionSettingsPaths().projectPath;
		let root: unknown;
		if (existsSync(projectPath)) {
			try {
				root = JSON.parse(readFileSync(projectPath, "utf8"));
			} catch {
				// Ignore parse errors on disk reads; fall back to global
			}
		}
		if (isRecord(root) && isRecord(root[WEB_SEARCH_SETTINGS_KEY])) {
			return deepMergeSettings(globalSection, root[WEB_SEARCH_SETTINGS_KEY]);
		}
	}
	return globalSection;
}

export function loadConfig(path?: string): WebSearchConfig {
	return readWebSearchSection(path) as WebSearchConfig;
}

export async function saveConfig(
	updates: Partial<WebSearchConfig>,
	customPath?: string,
): Promise<void> {
	const path = customPath ?? getWebSearchSettingsPath();
	await updateJsonSettingsRoot(path, (root) => {
		const current = isRecord(root[WEB_SEARCH_SETTINGS_KEY])
			? (root[WEB_SEARCH_SETTINGS_KEY] as Record<string, unknown>)
			: {};
		root[WEB_SEARCH_SETTINGS_KEY] = deepMergeSettings(current, updates as Record<string, unknown>);
	});
}

export function createWebSearchSettingsProvider(options?: { path?: string }): SettingsProvider {
	return {
		id: "pi-web-access",
		title: "Web Access",
		origin: "@hheei/pi-web-access",
		description: "Configure web search providers, URL extraction, and query workflows.",
		groups: [
			{
				id: WEB_SEARCH_SETTINGS_KEY,
				title: "Web Search",
				description: "Configure web search providers, API keys, and routing options.",
				fields: [
					{
						id: "workflow",
						label: "Workflow",
						type: "enum",
						defaultValue: "auto-summary",
						description: "Workflow mode used for web search results review and summarization.",
						options: [
							{ value: "auto-summary", label: "Auto Summary" },
							{ value: "summary-review", label: "Summary Review" },
							{ value: "direct", label: "Direct Results" },
						],
						parse: (value) => value,
					},
					{
						id: "toolExposure",
						label: "Tool Exposure",
						type: "enum",
						defaultValue: "deferred",
						description:
							"Whether web tools are directly active or deferred for tool_search discovery.",
						options: [
							{ value: "deferred", label: "Deferred (tool_search)" },
							{ value: "direct", label: "Direct (eager)" },
						],
						parse: (value) => value,
					},
				],
			},
		],
		storage: {
			async load(context) {
				const path = options?.path ?? defaultExtensionSettingsPaths().globalPath;
				const root = await readJsonSettingsRoot(path, context.signal);
				const group = root[WEB_SEARCH_SETTINGS_KEY];
				if (group !== undefined && !isRecord(group))
					throw new Error(`Expected ${WEB_SEARCH_SETTINGS_KEY} to be an object in ${path}`);
				if (!isRecord(group)) return undefined;
				return {
					[WEB_SEARCH_SETTINGS_KEY]: Object.fromEntries(
						Object.entries(group).filter((entry): entry is [string, SettingValue] =>
							isSettingValue(entry[1]),
						),
					),
				};
			},
			async save(state, context) {
				const path = options?.path ?? defaultExtensionSettingsPaths().globalPath;
				await updateJsonSettingsRoot(
					path,
					(root) => {
						const current = isRecord(root[WEB_SEARCH_SETTINGS_KEY])
							? (root[WEB_SEARCH_SETTINGS_KEY] as Record<string, unknown>)
							: {};
						root[WEB_SEARCH_SETTINGS_KEY] = {
							...current,
							...(state[WEB_SEARCH_SETTINGS_KEY] ?? {}),
						};
					},
					context.signal,
				);
			},
		},
	};
}
