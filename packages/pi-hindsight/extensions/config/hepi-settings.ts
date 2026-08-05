import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HepiSettingsProvider, HepiSettingsState } from "@hheei/pi-ext-core";
import { getHepiRuntimeSettingsRegistry, registerHepiSettings } from "@hheei/pi-ext-core";
import { DEFAULT_CONFIG } from "./config.js";
import { buildProjectConfigPatch, readGlobalConfig, writeGlobalConfig } from "./config-writer.js";

const SETTINGS_ID = "pi-hindsight";
const CONNECTION_GROUP = "connection";
const MEMORY_GROUP = "memory";

function recordAt(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function booleanAt(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function numberAt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function textAt(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function stateFromGlobalConfig(): HepiSettingsState {
	const config = readGlobalConfig();
	const hindsight = recordAt(config.hindsight);
	const recall = recordAt(config.recall);
	const retain = recordAt(config.retain);
	return {
		[CONNECTION_GROUP]: {
			enabled: booleanAt(config.enabled, DEFAULT_CONFIG.enabled),
			baseUrl: textAt(hindsight?.baseUrl, DEFAULT_CONFIG.hindsight.baseUrl),
			timeoutMs: numberAt(hindsight?.timeoutMs, DEFAULT_CONFIG.hindsight.timeoutMs),
		},
		[MEMORY_GROUP]: {
			recallEnabled: booleanAt(recall?.enabled, DEFAULT_CONFIG.recall.enabled),
			recallBudget: textAt(recall?.budget, DEFAULT_CONFIG.recall.budget),
			retainEnabled: booleanAt(retain?.enabled, DEFAULT_CONFIG.retain.enabled),
		},
	};
}

function budgetAt(value: unknown): "low" | "mid" | "high" {
	return value === "low" || value === "high" ? value : "mid";
}

function positiveNumberAt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createHindsightSettingsProvider(): HepiSettingsProvider {
	return {
		id: SETTINGS_ID,
		title: "Hindsight",
		origin: "@hheei/pi-hindsight",
		description: "Global defaults for the Hindsight memory extension.",
		groups: [
			{
				id: CONNECTION_GROUP,
				title: "Connection",
				fields: [
					{
						id: "enabled",
						label: "Extension enabled",
						type: "boolean",
						defaultValue: DEFAULT_CONFIG.enabled,
						description:
							"Enable Hindsight automatically for sessions without a project-level override.",
						parse: (value) => value === "true",
					},
					{
						id: "baseUrl",
						label: "Hindsight API URL",
						type: "text",
						defaultValue: DEFAULT_CONFIG.hindsight.baseUrl,
						description:
							"Base URL used for Hindsight recall, retain, reflect, and bank setup requests.",
						parse: (value) => value.trim(),
						validate: (value) =>
							typeof value !== "string" || value.trim() === ""
								? "Hindsight API URL must not be empty"
								: undefined,
					},
					{
						id: "timeoutMs",
						label: "Request timeout (ms)",
						type: "number",
						defaultValue: DEFAULT_CONFIG.hindsight.timeoutMs,
						description:
							"Maximum wait for an individual Hindsight network request before it is treated as unavailable.",
						parse: (value) => Number(value),
						validate: (value) =>
							typeof value !== "number" || !Number.isFinite(value) || value <= 0
								? "Request timeout must be positive"
								: undefined,
					},
				],
			},
			{
				id: MEMORY_GROUP,
				title: "Memory",
				fields: [
					{
						id: "recallEnabled",
						label: "Automatic recall",
						type: "boolean",
						defaultValue: DEFAULT_CONFIG.recall.enabled,
						description:
							"Inject relevant Hindsight memory into model context before each provider request.",
						parse: (value) => value === "true",
					},
					{
						id: "recallBudget",
						label: "Recall budget",
						type: "enum",
						defaultValue: DEFAULT_CONFIG.recall.budget,
						options: ["low", "mid", "high"].map((value) => ({ value })),
						description:
							"Select the Hindsight recall budget used when no project-level configuration overrides it.",
						parse: budgetAt,
					},
					{
						id: "retainEnabled",
						label: "Automatic retain",
						type: "boolean",
						defaultValue: DEFAULT_CONFIG.retain.enabled,
						description:
							"Store completed project agent runs through the durable local Hindsight retain queue.",
						parse: (value) => value === "true",
					},
				],
			},
		],
		storage: {
			load: () => stateFromGlobalConfig(),
			async save(state): Promise<void> {
				const connection = state[CONNECTION_GROUP] ?? {};
				const memory = state[MEMORY_GROUP] ?? {};
				await writeGlobalConfig(
					buildProjectConfigPatch({
						enabled: booleanAt(connection.enabled, DEFAULT_CONFIG.enabled),
						baseUrl: textAt(connection.baseUrl, DEFAULT_CONFIG.hindsight.baseUrl),
						timeoutMs: positiveNumberAt(connection.timeoutMs, DEFAULT_CONFIG.hindsight.timeoutMs),
						recallEnabled: booleanAt(memory.recallEnabled, DEFAULT_CONFIG.recall.enabled),
						recallBudget: budgetAt(memory.recallBudget),
						retainEnabled: booleanAt(memory.retainEnabled, DEFAULT_CONFIG.retain.enabled),
						scope: "global",
					}),
				);
			},
		},
	};
}

export function registerHindsightSettings(pi: ExtensionAPI): () => void {
	return registerHepiSettings(
		createHindsightSettingsProvider(),
		getHepiRuntimeSettingsRegistry(pi),
	);
}
