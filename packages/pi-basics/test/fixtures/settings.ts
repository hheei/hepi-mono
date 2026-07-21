import type {
	HePiSettingField,
	HePiSettingGroup,
	HePiSettingsProvider,
} from "../../src/api/settings.js";
import { fakeStorage } from "../helpers.js";

const parseBoolean = (draft: string) => {
	if (draft === "true") return true;
	if (draft === "false") return false;
	throw new Error("expected true or false");
};

export const booleanField: HePiSettingField<boolean> = {
	id: "enabled",
	label: "Enabled",
	type: "boolean",
	defaultValue: true,
	parse: parseBoolean,
};

export const enumField: HePiSettingField<string> = {
	id: "mode",
	label: "Mode",
	type: "enum",
	defaultValue: "auto",
	options: [
		{ value: "auto", label: "Automatic" },
		{ value: "manual", label: "Manual" },
	],
	parse: (draft) => {
		if (draft !== "auto" && draft !== "manual") throw new Error("invalid mode");
		return draft;
	},
};

export const textField: HePiSettingField<string> = {
	id: "name",
	label: "Name",
	type: "text",
	defaultValue: "Alice",
	parse: (draft) => draft,
};

export const numberField: HePiSettingField<number> = {
	id: "count",
	label: "Count",
	type: "number",
	defaultValue: 2,
	parse: (draft) => {
		const value = Number(draft);
		if (!Number.isFinite(value)) throw new Error("expected finite number");
		return value;
	},
};

export const pathField: HePiSettingField<string> = {
	id: "root",
	label: "Root path",
	type: "path",
	defaultValue: "/tmp",
	parse: (draft) => draft,
};

export const settingsFields = [booleanField, enumField, textField, numberField, pathField] as const;

export const generalGroup: HePiSettingGroup = {
	id: "general",
	title: "General",
	description: "General settings",
	fields: settingsFields,
};

export const advancedGroup: HePiSettingGroup = {
	id: "advanced",
	title: "Advanced",
	fields: [enumField, pathField],
};

export const panelFixture = {
	id: "fixture-panel",
	label: "Fixture Panel",
	render: (width: number) => [`Panel ${width}`],
};

export function createSettingsFixture(
	overrides: Partial<HePiSettingsProvider> = {},
): HePiSettingsProvider {
	return {
		id: "fixture",
		title: "Fixture Settings",
		groups: [generalGroup, advancedGroup],
		panels: [panelFixture],
		storage: fakeStorage({ initial: { general: { enabled: true } } }),
		...overrides,
	};
}

export const emptyProvider = createSettingsFixture({
	id: "empty",
	title: "Empty",
	groups: [],
	panels: [],
});
export const delayedSaveProvider = createSettingsFixture({
	id: "delayed",
	title: "Delayed Save",
	storage: fakeStorage({ delayMs: 10 }),
});
export const failedSaveProvider = createSettingsFixture({
	id: "failed",
	title: "Failed Save",
	storage: fakeStorage({ failSave: new Error("save failed") }),
});
