import type { Theme } from "@earendil-works/pi-coding-agent";

export type SettingPrimitive = boolean | number | string;
export type SettingJson = SettingPrimitive | null | SettingJson[] | { [key: string]: SettingJson };
export type SettingDescription = string | ((theme: Theme) => string);

export interface SettingOption<T extends SettingPrimitive = SettingPrimitive> {
	value: T;
	label?: string;
	description?: SettingDescription;
}

export interface SettingField<T extends SettingPrimitive = SettingPrimitive> {
	id: string;
	label: string;
	description?: SettingDescription;
	defaultValue: T;
	options?: readonly SettingOption<T>[] | (() => readonly SettingOption<T>[]);
	format?: (value: T) => string;
	parse?: (value: string) => T;
}

export interface SettingGroup {
	id: string;
	title: string;
	description?: SettingDescription;
	display?: "group" | "plain" | "hidden";
	fields: readonly SettingField[];
}

export type SettingsState = Record<string, Record<string, SettingJson>>;

export interface SettingChange {
	groupId: string;
	fieldId: string;
	value: SettingPrimitive;
	state: SettingsState;
}

export type MaybePromise<T> = T | Promise<T>;
