import type { HepiSettingField, HepiSettingOption, HepiSettingTabCycle } from "./settings.js";

export type HepiModelThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface HepiModelSelectionOption extends HepiSettingOption<string> {
	readonly label: string;
}

export interface HepiModelSelectionCandidate {
	readonly provider: string;
	readonly id: string;
}

export interface HepiModelSelectionRegistry<T extends HepiModelSelectionCandidate> {
	getAvailable?(): readonly T[];
	hasConfiguredAuth(model: T): boolean;
}

export interface HepiModelThinkingCycle {
	readonly fieldId: string;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: HepiModelThinkingLevel;
	readonly options: readonly HepiSettingOption<HepiModelThinkingLevel>[];
}

export interface CreateHepiModelSelectionFieldOptions {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly modelOptions: readonly HepiModelSelectionOption[];
	readonly thinking: HepiModelThinkingLevel | HepiModelThinkingCycle;
}

export function hepiThinkingGlyph(level: unknown): string {
	if (level === "off" || level === "minimal") return "○";
	if (level === "low") return "◔";
	if (level === "medium") return "◑";
	if (level === "high") return "◕";
	if (level === "xhigh" || level === "max") return "●";
	return "?";
}

export function hepiModelSelectionOptions(
	models: Iterable<HepiModelSelectionCandidate>,
): readonly HepiModelSelectionOption[] {
	const values = new Set<string>();
	for (const model of models) values.add(`${model.provider}/${model.id}`);
	return [
		{ value: "", label: "Not set" },
		...[...values]
			.sort((left, right) => left.localeCompare(right))
			.map((value) => ({ value, label: value })),
	];
}

export function hepiAuthenticatedModelSelectionOptions<T extends HepiModelSelectionCandidate>(
	registry: HepiModelSelectionRegistry<T>,
): readonly HepiModelSelectionOption[] {
	return hepiModelSelectionOptions(
		(registry.getAvailable?.() ?? []).filter((model) => registry.hasConfiguredAuth(model)),
	);
}

export function createHepiModelSelectionField(
	options: CreateHepiModelSelectionFieldOptions,
): HepiSettingField<string> {
	const fixedThinking = typeof options.thinking === "string" ? options.thinking : undefined;
	const cycle = typeof options.thinking === "string" ? undefined : options.thinking;
	const thinking = (related: unknown): HepiModelThinkingLevel =>
		related === "off" ||
		related === "minimal" ||
		related === "low" ||
		related === "medium" ||
		related === "high" ||
		related === "xhigh" ||
		related === "max"
			? related
			: cycle === undefined
				? (fixedThinking ?? "off")
				: cycle.defaultValue;
	const tabCycle: HepiSettingTabCycle | undefined =
		cycle === undefined ? undefined : { ...cycle, separator: " " };
	const modelText = (value: string): string => value.trim() || "Not set";
	return {
		id: options.id,
		label: options.label,
		type: "enum",
		defaultValue: "",
		description: options.description,
		options: options.modelOptions,
		formatDisplay: (value, related) =>
			`${hepiThinkingGlyph(thinking(related))} ${modelText(value)}`,
		formatDescription: (value, related) => `${modelText(value)} ${thinking(related)}`,
		parse: (draft) => draft,
		validate: (value) =>
			typeof value === "string" && value.length > 0 && !/^[^/\s]+\/[^/\s]+$/u.test(value)
				? "Use provider/model"
				: undefined,
		...(tabCycle === undefined ? {} : { tabCycle }),
	};
}
