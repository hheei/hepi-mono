import type { HepiSettingField, HepiSettingOption, HepiSettingTabCycle } from "./settings.js";

export type HepiModelThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

/** A settings-host option whose value is the exact `provider/model` reference. */
export interface HepiModelSelectionOption extends HepiSettingOption<string> {
	readonly label: string;
}

/** Minimal model identity needed to build a settings option list. */
export interface HepiModelSelectionCandidate {
	readonly provider: string;
	readonly id: string;
}

export interface HepiModelSelectionRegistry<T extends HepiModelSelectionCandidate> {
	/** Missing availability means the caller receives only the `Not set` option. */
	getAvailable?(): readonly T[];
	/** Authentication filtering belongs to the host registry, not core. */
	hasConfiguredAuth(model: T): boolean;
}

/** Declarative thinking-level cycle rendered beside a model field by a settings host. */
export interface HepiModelThinkingCycle {
	readonly fieldId: string;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: HepiModelThinkingLevel;
	readonly options: readonly HepiSettingOption<HepiModelThinkingLevel>[];
}

/** Inputs for a model field; core validates the reference shape but not provider policy. */
export interface CreateHepiModelSelectionFieldOptions {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly modelOptions: readonly HepiModelSelectionOption[];
	readonly thinking: HepiModelThinkingLevel | HepiModelThinkingCycle;
}

/** Maps untrusted setting values to a stable display glyph, with `?` as fallback. */
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
	// Deduplicate and sort so settings panels remain stable across provider reloads.
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
	// Auth filtering is intentionally performed before exposing options; consumers
	// may still validate a saved reference separately when loading settings.
	return hepiModelSelectionOptions(
		(registry.getAvailable?.() ?? []).filter((model) => registry.hasConfiguredAuth(model)),
	);
}

export function createHepiModelSelectionField(
	options: CreateHepiModelSelectionFieldOptions,
): HepiSettingField<string> {
	// The field stores only the model reference. Thinking is a related display/control
	// value so core does not persist or own a second model-selection state machine.
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
