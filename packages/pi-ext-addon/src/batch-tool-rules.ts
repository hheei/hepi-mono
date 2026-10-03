import {
	createJsonSettingsStorage,
	isRecord,
	type SettingField,
	type SettingsProvider,
	type SettingsStorage,
	setPromptSection,
} from "@hheei/pi-ext-core";

export const BATCH_TOOL_RULES_SECTION = "tool_execution_rules";
export const BATCH_TOOL_RULES_GROUP = "batch-tool-rules";
export const BATCH_TOOL_RULES_SETTINGS_PROVIDER_ID = "batch-tool-rules";
export const BATCH_TOOL_RULES_ENABLED_FIELD = "enabled";
export const BATCH_TOOL_RULES_CUSTOM_FIELD = "prompt";

export function buildDefaultBatchToolPrompt(hasCodemode: boolean, hasEval: boolean): string {
	let viaClause = "";
	if (hasCodemode) {
		viaClause = hasEval ? " via `codemode` or `eval`" : " via `codemode`";
	}
	return `<tool_execution_rules>
Agent turns are extremely expensive. You MUST batch and execute as many tool calls as possible in a single turn${viaClause}.
</tool_execution_rules>`;
}

export function buildBatchToolPrompt(
	options: {
		readonly hasCodemode?: boolean;
		readonly hasEval?: boolean;
		readonly customPrompt?: string;
	} = {},
): string {
	if (options.customPrompt !== undefined && options.customPrompt.trim() !== "") {
		return options.customPrompt;
	}
	return buildDefaultBatchToolPrompt(options.hasCodemode ?? false, options.hasEval ?? false);
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
): void {
	const sections = event.systemPromptOptions?.sections;
	if (!sections) return;

	if (config.enabled) {
		const selected = event.systemPromptOptions?.selectedTools;
		const active = getActiveTools?.();
		const hasCodemode =
			(selected?.includes("codemode") ?? false) || (active?.includes("codemode") ?? false);
		const hasEval = (selected?.includes("eval") ?? false) || (active?.includes("eval") ?? false);

		const prompt = buildBatchToolPrompt({
			hasCodemode,
			hasEval,
			customPrompt: config.prompt,
		});
		setPromptSection(sections, BATCH_TOOL_RULES_SECTION, prompt);
	} else {
		setPromptSection(sections, BATCH_TOOL_RULES_SECTION, undefined);
	}
}
