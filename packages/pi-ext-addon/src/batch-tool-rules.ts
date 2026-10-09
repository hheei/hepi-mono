import {
	createJsonSettingsStorage,
	isRecord,
	type SettingField,
	type SettingsProvider,
	type SettingsStorage,
	setPromptSection,
} from "@hheei/pi-ext-core";
import { isGeminiModel } from "./codemode-guard.js";

export const BATCH_TOOL_RULES_SECTION = "tool_execution_rules";
export const BATCH_TOOL_RULES_GROUP = "batch-tool-rules";
export const BATCH_TOOL_RULES_SETTINGS_PROVIDER_ID = "batch-tool-rules";
export const BATCH_TOOL_RULES_ENABLED_FIELD = "enabled";
export const BATCH_TOOL_RULES_CUSTOM_FIELD = "prompt";

export function buildDefaultBatchToolPrompt(
	hasCodemode: boolean,
	hasEval: boolean,
	isGemini = false,
): string {
	let viaClause = "";
	if (hasCodemode) {
		viaClause = hasEval ? " via `codemode` or `python_eval`" : " via `codemode`";
	}
	const geminiGuidance = isGemini
		? " Call as many `read` and `grep` operations in parallel as possible to locate information much faster."
		: "";
	const noCommentsGuidance =
		hasCodemode || hasEval ? " Do not write comments when using `codemode` and `python_eval`." : "";
	return `<tool_execution_rules>
Agent turns are extremely expensive. You MUST batch and execute as many tool calls as possible in a single turn${viaClause}.${geminiGuidance}${noCommentsGuidance}
</tool_execution_rules>`;
}

export function buildBatchToolPrompt(
	options: {
		readonly hasCodemode?: boolean;
		readonly hasEval?: boolean;
		readonly customPrompt?: string;
		readonly isGemini?: boolean;
	} = {},
): string {
	if (options.customPrompt !== undefined && options.customPrompt.trim() !== "") {
		return options.customPrompt;
	}
	return buildDefaultBatchToolPrompt(
		options.hasCodemode ?? false,
		options.hasEval ?? false,
		options.isGemini ?? false,
	);
}

export interface BatchToolRulesConfig {
	readonly enabled: boolean;
	readonly prompt: string;
}

export const DEFAULT_BATCH_TOOL_RULES_CONFIG: BatchToolRulesConfig = {
	enabled: true,
	prompt: "",
};

export function normalizeBatchToolRulesConfig(value: unknown): BatchToolRulesConfig {
	if (!isRecord(value)) return DEFAULT_BATCH_TOOL_RULES_CONFIG;
	return {
		enabled:
			typeof value[BATCH_TOOL_RULES_ENABLED_FIELD] === "boolean"
				? value[BATCH_TOOL_RULES_ENABLED_FIELD]
				: DEFAULT_BATCH_TOOL_RULES_CONFIG.enabled,
		prompt:
			typeof value[BATCH_TOOL_RULES_CUSTOM_FIELD] === "string"
				? value[BATCH_TOOL_RULES_CUSTOM_FIELD]
				: DEFAULT_BATCH_TOOL_RULES_CONFIG.prompt,
	};
}

export function createBatchToolRulesStorage(
	options: { readonly path?: string } = {},
): SettingsStorage {
	return createJsonSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
		group: BATCH_TOOL_RULES_GROUP,
	});
}

export interface BatchToolRulesSettingsOptions {
	readonly path?: string;
	readonly onSettingsChange?: (config: BatchToolRulesConfig) => void;
}

export function createBatchToolRulesSettingsProvider(
	options: BatchToolRulesSettingsOptions = {},
): SettingsProvider {
	const baseStorage = createBatchToolRulesStorage({
		...(options.path === undefined ? {} : { path: options.path }),
	});
	const storage: SettingsStorage = {
		load: (ctx) => baseStorage.load(ctx),
		save: async (state, ctx) => {
			await baseStorage.save(state, ctx);
			const group = state[BATCH_TOOL_RULES_GROUP];
			options.onSettingsChange?.(normalizeBatchToolRulesConfig(group));
		},
	};

	const fields: readonly SettingField[] = [
		{
			id: BATCH_TOOL_RULES_ENABLED_FIELD,
			label: "Inject tool batching rules",
			type: "boolean",
			defaultValue: DEFAULT_BATCH_TOOL_RULES_CONFIG.enabled,
			description:
				"Inject rules into system prompt instructing the model to batch tool calls via codemode or eval.",
			parse: (draft) => draft === "true",
		},
		{
			id: BATCH_TOOL_RULES_CUSTOM_FIELD,
			label: "Custom tool execution rules",
			type: "text",
			defaultValue: DEFAULT_BATCH_TOOL_RULES_CONFIG.prompt,
			description:
				"Optional custom prompt. Leave empty to automatically adapt based on active tools (codemode, eval).",
			parse: (draft) => draft,
			enabled: (state) => state[BATCH_TOOL_RULES_GROUP]?.[BATCH_TOOL_RULES_ENABLED_FIELD] !== false,
		},
	];

	return {
		id: BATCH_TOOL_RULES_SETTINGS_PROVIDER_ID,
		title: "Batch tool rules",
		origin: "@hheei/pi-ext-addon",
		groups: [
			{
				id: BATCH_TOOL_RULES_GROUP,
				title: "Batch tool rules",
				description: "Instruct models to batch as many tool calls as possible in a single turn.",
				fields,
			},
		],
		storage,
		onChange(change) {
			if (change.groupId !== BATCH_TOOL_RULES_GROUP) return;
			const group = change.state[BATCH_TOOL_RULES_GROUP];
			options.onSettingsChange?.(normalizeBatchToolRulesConfig(group));
		},
	};
}

export function applyBatchToolRules(
	event: {
		systemPromptOptions?: {
			sections?: Record<string, string>;
			selectedTools?: readonly string[];
		};
	},
	config: BatchToolRulesConfig = DEFAULT_BATCH_TOOL_RULES_CONFIG,
	getActiveTools?: () => readonly string[],
	model?: unknown,
): void {
	const sections = event.systemPromptOptions?.sections;
	if (!sections) return;

	if (config.enabled) {
		const selected = event.systemPromptOptions?.selectedTools;
		const active = getActiveTools?.();
		const hasCodemode =
			(selected?.includes("codemode") ?? false) || (active?.includes("codemode") ?? false);
		const hasEval =
			(selected?.includes("python_eval") ?? false) || (active?.includes("python_eval") ?? false);
		const isGemini = isGeminiModel(model);

		const prompt = buildBatchToolPrompt({
			hasCodemode,
			hasEval,
			customPrompt: config.prompt,
			isGemini,
		});
		setPromptSection(sections, BATCH_TOOL_RULES_SECTION, prompt);
	} else {
		setPromptSection(sections, BATCH_TOOL_RULES_SECTION, undefined);
	}
}
