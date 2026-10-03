import {
	authenticatedModelSelectionOptions,
	createModelSelectionField,
	defaultExtensionSettingsPaths,
	isRecord,
	type ModelSelectionCandidate,
	type ModelSelectionOption,
	type ModelSelectionRegistry,
	type ModelThinkingCycle,
	type ModelThinkingLevel,
	readJsonSettingsRoot,
	type SettingField,
	type SettingsContext,
	type SettingsProvider,
	type SettingsState,
	type SettingsStorage,
	updateJsonSettingsRoot,
} from "@hheei/pi-ext-core";
import { HINDSIGHT_DEFAULTS } from "./hindsight/config.js";

export const MEMORY_SETTINGS_PROVIDER_ID = "pi-ext-memory";
export const MEMORY_SETTINGS_GROUP = "pi-ext-memory";

export const MEMORY_MODEL_FIELD = "model";
export const MEMORY_MODEL_THINKING_FIELD = "modelThinking";
export const MEMORY_PASSIVE_FIELD = "passive";
export const MEMORY_NOTIFICATIONS_FIELD = "showWorkerNotifications";
export const MEMORY_DEBUG_LOG_FIELD = "debugLog";

export const HINDSIGHT_ENABLED_FIELD = "hindsightEnabled";
export const HINDSIGHT_API_URL_FIELD = "hindsightApiUrl";
export const HINDSIGHT_BANK_ID_FIELD = "hindsightBankId";
export const HINDSIGHT_AUTO_RECALL_FIELD = "hindsightAutoRecall";
export const HINDSIGHT_RETAIN_SESSIONS_FIELD = "hindsightRetainSessions";

export const MEMORY_THINKING_CYCLE: ModelThinkingCycle = {
	fieldId: MEMORY_MODEL_THINKING_FIELD,
	label: "thinking",
	description: "Reasoning and thinking level for background memory workers.",
	defaultValue: "low",
	options: [
		{ value: "off", label: "off" },
		{ value: "minimal", label: "minimal" },
		{ value: "low", label: "low" },
		{ value: "medium", label: "medium" },
		{ value: "high", label: "high" },
		{ value: "xhigh", label: "xhigh" },
		{ value: "max", label: "max" },
	],
};

export function ensureModelOption(
	options: readonly ModelSelectionOption[],
	configuredRef?: string,
): readonly ModelSelectionOption[] {
	if (!configuredRef) return options;
	if (options.some((opt) => opt.value === configuredRef)) return options;
	return [...options, { value: configuredRef, label: configuredRef }];
}

export function parseModelRef(ref: string): { provider: string; model: string } {
	const split = ref.split("/");
	if (split.length < 2 || !split[0] || !split.slice(1).join("/")) {
		throw new Error("Model must be in provider/id format");
	}
	return { provider: split[0], model: split.slice(1).join("/") };
}

export function createMemorySettingsStorage(
	options: {
		readonly path?: string;
		readonly onSaved?: (context: SettingsContext) => Promise<void> | void;
	} = {},
): SettingsStorage {
	return {
		async load(context): Promise<SettingsState | undefined> {
			const path = options.path ?? defaultExtensionSettingsPaths(context.cwd).globalPath;
			const root = await readJsonSettingsRoot(path, context.signal);
			const group = root[MEMORY_SETTINGS_GROUP];
			const section = isRecord(group) ? group : {};

			let model = "";
			let modelThinking: ModelThinkingLevel = "low";
			if (isRecord(section.model)) {
				const provider = typeof section.model.provider === "string" ? section.model.provider : "";
				const id = typeof section.model.id === "string" ? section.model.id : "";
				if (provider && id) {
					model = `${provider}/${id}`;
				}
				if (typeof section.model.thinking === "string") {
					modelThinking = section.model.thinking as ModelThinkingLevel;
				}
			}

			const hindsight = isRecord(section.hindsight) ? section.hindsight : {};
			const hindsightEnabled = hindsight.enabled === true;
			const hindsightApiUrl =
				typeof hindsight.apiUrl === "string" && hindsight.apiUrl.length > 0
					? hindsight.apiUrl
					: HINDSIGHT_DEFAULTS.apiUrl;
			const hindsightBankId = typeof hindsight.bankId === "string" ? hindsight.bankId : "";
			const hindsightAutoRecall =
				typeof hindsight.autoRecall === "boolean"
					? hindsight.autoRecall
					: HINDSIGHT_DEFAULTS.autoRecall;
			const hindsightRetainSessions =
				typeof hindsight.retainSessions === "boolean"
					? hindsight.retainSessions
					: HINDSIGHT_DEFAULTS.retainSessions;

			const passive = section.passive === true;
			const showWorkerNotifications = section.showWorkerNotifications !== false;
			const debugLog = section.debugLog === true;

			return {
				[MEMORY_SETTINGS_GROUP]: {
					[MEMORY_MODEL_FIELD]: model,
					[MEMORY_MODEL_THINKING_FIELD]: modelThinking,
					[MEMORY_PASSIVE_FIELD]: passive,
					[MEMORY_NOTIFICATIONS_FIELD]: showWorkerNotifications,
					[MEMORY_DEBUG_LOG_FIELD]: debugLog,
					[HINDSIGHT_ENABLED_FIELD]: hindsightEnabled,
					[HINDSIGHT_API_URL_FIELD]: hindsightApiUrl,
					[HINDSIGHT_BANK_ID_FIELD]: hindsightBankId,
					[HINDSIGHT_AUTO_RECALL_FIELD]: hindsightAutoRecall,
					[HINDSIGHT_RETAIN_SESSIONS_FIELD]: hindsightRetainSessions,
				},
			};
		},

		async save(state, context): Promise<void> {
			const path = options.path ?? defaultExtensionSettingsPaths(context.cwd).globalPath;
			const values = state[MEMORY_SETTINGS_GROUP] ?? {};

			await updateJsonSettingsRoot(
				path,
				(root) => {
					const existingGroup = root[MEMORY_SETTINGS_GROUP];
					const existing = isRecord(existingGroup) ? { ...existingGroup } : {};

					const modelVal = values[MEMORY_MODEL_FIELD];
					if (typeof modelVal === "string" && modelVal.trim().length > 0) {
						try {
							const { provider, model: id } = parseModelRef(modelVal.trim());
							const thinkingVal = values[MEMORY_MODEL_THINKING_FIELD];
							existing.model = {
								provider,
								id,
								...(typeof thinkingVal === "string" && thinkingVal.length > 0
									? { thinking: thinkingVal }
									: {}),
							};
						} catch {
							delete existing.model;
						}
					} else {
						delete existing.model;
					}

					const existingHindsight = isRecord(existing.hindsight) ? { ...existing.hindsight } : {};
					existingHindsight.enabled = values[HINDSIGHT_ENABLED_FIELD] === true;
					const apiUrl = values[HINDSIGHT_API_URL_FIELD];
					if (typeof apiUrl === "string" && apiUrl.trim().length > 0) {
						existingHindsight.apiUrl = apiUrl.trim();
					}
					const bankId = values[HINDSIGHT_BANK_ID_FIELD];
					if (typeof bankId === "string" && bankId.trim().length > 0) {
						existingHindsight.bankId = bankId.trim();
					} else {
						delete existingHindsight.bankId;
					}
					existingHindsight.autoRecall = values[HINDSIGHT_AUTO_RECALL_FIELD] === true;
					existingHindsight.retainSessions = values[HINDSIGHT_RETAIN_SESSIONS_FIELD] === true;
					existing.hindsight = existingHindsight;

					if (typeof values[MEMORY_PASSIVE_FIELD] === "boolean") {
						existing.passive = values[MEMORY_PASSIVE_FIELD];
					}
					if (typeof values[MEMORY_NOTIFICATIONS_FIELD] === "boolean") {
						existing.showWorkerNotifications = values[MEMORY_NOTIFICATIONS_FIELD];
					}
					if (typeof values[MEMORY_DEBUG_LOG_FIELD] === "boolean") {
						existing.debugLog = values[MEMORY_DEBUG_LOG_FIELD];
					}

					root[MEMORY_SETTINGS_GROUP] = existing;
				},
				context.signal,
			);

			await options.onSaved?.(context);
		},
	};
}

export interface MemorySettingsProviderOptions {
	readonly path?: string | undefined;
	readonly modelRegistry?: ModelSelectionRegistry<ModelSelectionCandidate> | undefined;
	readonly configuredModel?: string | undefined;
	readonly onSaved?: ((context: SettingsContext) => Promise<void> | void) | undefined;
}

export function createMemorySettingsProvider(
	options: MemorySettingsProviderOptions = {},
): SettingsProvider {
	let modelOptions: readonly ModelSelectionOption[] = options.modelRegistry
		? authenticatedModelSelectionOptions(options.modelRegistry)
		: [{ value: "", label: "Not set" }];

	if (options.configuredModel) {
		modelOptions = ensureModelOption(modelOptions, options.configuredModel);
	}

	const fields: readonly SettingField[] = [
		createModelSelectionField({
			id: MEMORY_MODEL_FIELD,
			label: "worker model",
			description: "Model override for memory observer, reflector, and dropper workers.",
			modelOptions,
			thinking: MEMORY_THINKING_CYCLE,
		}),
		{
			id: MEMORY_PASSIVE_FIELD,
			label: "passive mode",
			type: "boolean",
			defaultValue: false,
			description: "Disable background observer and proactive compaction triggers.",
			parse: (draft) => draft === "true",
		},
		{
			id: MEMORY_NOTIFICATIONS_FIELD,
			label: "worker notices",
			type: "boolean",
			defaultValue: true,
			description: "Show background worker start and completion notifications.",
			parse: (draft) => draft === "true",
		},
		{
			id: HINDSIGHT_ENABLED_FIELD,
			label: "hindsight memory",
			type: "boolean",
			defaultValue: false,
			description: "Enable or disable Hindsight long-term cross-session memory.",
			parse: (draft) => draft === "true",
		},
		{
			id: HINDSIGHT_API_URL_FIELD,
			label: "hindsight API URL",
			type: "text",
			defaultValue: HINDSIGHT_DEFAULTS.apiUrl,
			description: "Base URL of the Hindsight memory backend service instance.",
			parse: (draft) => draft.trim(),
			enabled: (state) => state[MEMORY_SETTINGS_GROUP]?.[HINDSIGHT_ENABLED_FIELD] === true,
		},
		{
			id: HINDSIGHT_BANK_ID_FIELD,
			label: "hindsight bank ID",
			type: "text",
			defaultValue: "",
			description: "Dedicated or shared bank ID for Hindsight memory storage.",
			parse: (draft) => draft.trim(),
			enabled: (state) => state[MEMORY_SETTINGS_GROUP]?.[HINDSIGHT_ENABLED_FIELD] === true,
		},
		{
			id: HINDSIGHT_AUTO_RECALL_FIELD,
			label: "hindsight recall",
			type: "boolean",
			defaultValue: HINDSIGHT_DEFAULTS.autoRecall,
			description: "Automatically recall relevant memory pages before each turn.",
			parse: (draft) => draft === "true",
			enabled: (state) => state[MEMORY_SETTINGS_GROUP]?.[HINDSIGHT_ENABLED_FIELD] === true,
		},
		{
			id: HINDSIGHT_RETAIN_SESSIONS_FIELD,
			label: "hindsight retain",
			type: "boolean",
			defaultValue: HINDSIGHT_DEFAULTS.retainSessions,
			description: "Retain completed conversation turns into Hindsight memory.",
			parse: (draft) => draft === "true",
			enabled: (state) => state[MEMORY_SETTINGS_GROUP]?.[HINDSIGHT_ENABLED_FIELD] === true,
		},
		{
			id: MEMORY_DEBUG_LOG_FIELD,
			label: "debug log",
			type: "boolean",
			defaultValue: false,
			description: "Write observational-memory debug events to local NDJSON files.",
			parse: (draft) => draft === "true",
		},
	];

	return {
		id: MEMORY_SETTINGS_PROVIDER_ID,
		title: "Observational Memory",
		origin: "@hheei/pi-ext-memory",
		description: "Session memory consolidation and Hindsight long-term memory integration.",
		groups: [
			{
				id: MEMORY_SETTINGS_GROUP,
				title: "",
				fields,
			},
		],
		storage: createMemorySettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			...(options.onSaved === undefined ? {} : { onSaved: options.onSaved }),
		}),
	};
}
