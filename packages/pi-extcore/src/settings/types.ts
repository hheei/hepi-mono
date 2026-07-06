export type SettingPrimitive = boolean | number | string;

export interface SettingOption<T extends SettingPrimitive = SettingPrimitive> {
	value: T;
	label?: string;
	description?: string;
}

export interface SettingField<T extends SettingPrimitive = SettingPrimitive> {
	id: string;
	label: string;
	description?: string;
	defaultValue: T;
	options?: readonly SettingOption<T>[];
	format?: (value: T) => string;
	parse?: (value: string) => T;
}

export interface SettingGroup {
	id: string;
	title: string;
	description?: string;
	fields: readonly SettingField[];
}

export type SettingsState = Record<string, Record<string, SettingPrimitive>>;

export interface SettingChange {
	groupId: string;
	fieldId: string;
	value: SettingPrimitive;
	state: SettingsState;
}

export type MaybePromise<T> = T | Promise<T>;
