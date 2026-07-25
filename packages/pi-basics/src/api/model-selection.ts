import type { HePiSettingField, HePiSettingOption, HePiSettingTabCycle } from "./settings.js";

export type HePiModelThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface HePiModelSelectionOption extends HePiSettingOption<string> {
	readonly label: string;
}

export interface HePiModelSelectionCandidate {
	readonly provider: string;
	readonly id: string;
}

export interface HePiModelSelectionRegistry<T extends HePiModelSelectionCandidate> {
	getAvailable?(): readonly T[];
	getRegisteredProviderIds(): readonly string[];
	hasConfiguredAuth(model: T): boolean;
}

export interface HePiModelThinkingCycle {
	readonly fieldId: string;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: HePiModelThinkingLevel;
	readonly options: readonly HePiSettingOption<HePiModelThinkingLevel>[];
}

export interface CreateHePiModelSelectionFieldOptions {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly modelOptions: readonly HePiModelSelectionOption[];
	readonly thinking: HePiModelThinkingLevel | HePiModelThinkingCycle;
}

export function hePiThinkingGlyph(level: unknown): string {
	if (level === "off" || level === "minimal") return "○";
	if (level === "low") return "◔";
	if (level === "medium") return "◑";
	if (level === "high") return "◕";
	if (level === "xhigh" || level === "max") return "●";
	return "?";
}

export function hePiModelSelectionOptions(
	models: Iterable<HePiModelSelectionCandidate>,
): readonly HePiModelSelectionOption[] {
	const values = new Set<string>();
	for (const model of models) values.add(`${model.provider}/${model.id}`);
	return [
		{ value: "", label: "Not set" },
		...[...values]
			.sort((left, right) => left.localeCompare(right))
			.map((value) => ({ value, label: value })),
	];
}

export function hePiAuthenticatedModelSelectionOptions<T extends HePiModelSelectionCandidate>(
	registry: HePiModelSelectionRegistry<T>,
): readonly HePiModelSelectionOption[] {
	const providers = new Set(registry.getRegisteredProviderIds());
	return hePiModelSelectionOptions(
		(registry.getAvailable?.() ?? []).filter(
			(model) => providers.has(model.provider) && registry.hasConfiguredAuth(model),
		),
	);
}

export function createHePiModelSelectionField(
	options: CreateHePiModelSelectionFieldOptions,
): HePiSettingField<string> {
	const fixedThinking: HePiModelThinkingLevel | undefined =
		typeof options.thinking === "string" ? options.thinking : undefined;
	const cycle: HePiModelThinkingCycle | undefined =
		typeof options.thinking === "string" ? undefined : options.thinking;
	const thinking = (related: unknown): HePiModelThinkingLevel =>
		related === "off" ||
		related === "minimal" ||
		related === "low" ||
		related === "medium" ||
		related === "high" ||
		related === "xhigh" ||
		related === "max"
			? related
			: cycle
				? cycle.defaultValue
				: (fixedThinking ?? "off");
	const modelText = (value: string): string => value.trim() || "Not set";
	const tabCycle: HePiSettingTabCycle | undefined = cycle
		? { ...cycle, separator: " " }
		: undefined;
	return {
		id: options.id,
		label: options.label,
		type: "enum",
		defaultValue: "",
		description: options.description,
		options: options.modelOptions,
		formatDisplay: (value, related) =>
			`${hePiThinkingGlyph(thinking(related))} ${modelText(value)}`,
		formatDescription: (value, related) => `${modelText(value)} ${thinking(related)}`,
		parse: (draft) => draft,
		validate: (value) =>
			typeof value === "string" && value.length > 0 && !/^[^/\s]+\/[^/\s]+$/u.test(value)
				? "Use provider/model"
				: undefined,
		...(tabCycle === undefined ? {} : { tabCycle }),
	};
}
