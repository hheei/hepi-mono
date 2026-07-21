import type {
	SettingChange,
	SettingField,
	SettingGroup,
	SettingOption,
	SettingPrimitive,
	SettingsState,
} from "./types.js";

const itemIdSeparator = ":";

export function encodeSettingItemId(groupId: string, fieldId: string): string {
	return `${groupId}${itemIdSeparator}${fieldId}`;
}

export function decodeSettingItemId(itemId: string): { groupId: string; fieldId: string } {
	const index = itemId.indexOf(itemIdSeparator);
	if (index === -1) {
		return { groupId: "", fieldId: itemId };
	}

	return {
		groupId: itemId.slice(0, index),
		fieldId: itemId.slice(index + itemIdSeparator.length),
	};
}

export function createDefaultSettingsState(groups: readonly SettingGroup[]): SettingsState {
	const state: SettingsState = {};
	for (const group of groups) {
		state[group.id] = {};
		for (const field of group.fields) {
			state[group.id]![field.id] = field.defaultValue;
		}
	}
	return state;
}

export function mergeSettingsState(
	groups: readonly SettingGroup[],
	state: SettingsState | undefined,
): SettingsState {
	const merged = createDefaultSettingsState(groups);
	if (!state) {
		return merged;
	}

	for (const group of groups) {
		const savedGroup = state[group.id];
		if (!savedGroup) {
			continue;
		}

		for (const field of group.fields) {
			const savedValue = savedGroup[field.id];
			if (
				savedValue !== undefined &&
				(group.display === "hidden" || isCompatibleSettingValue(field, savedValue))
			) {
				merged[group.id]![field.id] = savedValue;
			}
		}
	}

	return merged;
}

export function getSettingValue<T extends SettingPrimitive>(
	state: SettingsState,
	groupId: string,
	field: SettingField<T>,
): T {
	const value = state[groupId]?.[field.id];
	return (value === undefined ? field.defaultValue : value) as T;
}

export function formatSettingValue<T extends SettingPrimitive>(
	field: SettingField<T>,
	value: T,
): string {
	if (field.format) {
		return field.format(value);
	}

	const option = resolveSettingOptions(field).find((item) => item.value === value);
	return option?.label ?? String(value);
}

export function settingValueLabels<T extends SettingPrimitive>(field: SettingField<T>): string[] {
	const options = resolveSettingOptions(field);
	if (options.length > 0) {
		return options.map((option) => option.label ?? String(option.value));
	}

	if (typeof field.defaultValue === "boolean") {
		return ["true", "false"];
	}

	return [formatSettingValue(field, field.defaultValue)];
}

function resolveSettingOptions<T extends SettingPrimitive>(
	field: SettingField<T>,
): readonly SettingOption<T>[] {
	return typeof field.options === "function" ? field.options() : (field.options ?? []);
}

export function parseSettingValue<T extends SettingPrimitive>(
	field: SettingField<T>,
	displayValue: string,
): T {
	if (field.parse) {
		return field.parse(displayValue);
	}

	const option = resolveSettingOptions(field).find((item) => optionLabel(item) === displayValue);
	if (option) {
		return option.value;
	}

	if (typeof field.defaultValue === "boolean") {
		return (displayValue === "true") as T;
	}

	if (typeof field.defaultValue === "number") {
		return Number(displayValue) as T;
	}

	return displayValue as T;
}

export function applySettingChange(
	groups: readonly SettingGroup[],
	state: SettingsState,
	itemId: string,
	displayValue: string,
): SettingChange | undefined {
	const { groupId, fieldId } = decodeSettingItemId(itemId);
	const group = groups.find((item) => item.id === groupId);
	const field = group?.fields.find((item) => item.id === fieldId);
	if (!group || !field) {
		return undefined;
	}

	const value = parseSettingValue(field, displayValue);
	const nextState: SettingsState = {
		...state,
		[group.id]: {
			...(state[group.id] ?? {}),
			[field.id]: value,
		},
	};

	return {
		groupId: group.id,
		fieldId: field.id,
		value,
		state: nextState,
	};
}

function optionLabel(option: SettingOption): string {
	return option.label ?? String(option.value);
}

function isCompatibleSettingValue(field: SettingField, value: unknown): boolean {
	return typeof value === typeof field.defaultValue;
}
