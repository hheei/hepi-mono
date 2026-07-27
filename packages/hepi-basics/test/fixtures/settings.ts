import type {
	HepiSettingField,
	HepiSettingGroup,
	HepiSettingsProvider,
} from "../../src/core/api/settings.js";
import { fakeStorage } from "../helpers.js";

const parseBoolean = (draft: string) => {
	if (draft === "true") return true;
	if (draft === "false") return false;
	throw new Error("expected true or false");
};

export const booleanField: HepiSettingField<boolean> = {
	id: "enabled",
	label: "Enabled",
	type: "boolean",
	defaultValue: true,
	description: "Enable or disable this fixture feature for controller behavior tests.",
	parse: parseBoolean,
};

export const enumField: HepiSettingField<string> = {
	id: "mode",
	label: "Mode",
	type: "enum",
	defaultValue: "auto",
	description: "Choose automatic or manual operation for enum setting behavior tests.",
	options: [
		{ value: "auto", label: "Automatic" },
		{ value: "manual", label: "Manual" },
	],
	parse: (draft) => {
		if (draft !== "auto" && draft !== "manual") throw new Error("invalid mode");
		return draft;
	},
};

export const textField: HepiSettingField<string> = {
	id: "name",
	label: "Name",
	type: "text",
	defaultValue: "Alice",
	description: "Set the display name used by text setting behavior tests.",
	parse: (draft) => draft,
};

export const numberField: HepiSettingField<number> = {
	id: "count",
	label: "Count",
	type: "number",
	defaultValue: 2,
	description: "Set the finite numeric count used by number setting behavior tests.",
	parse: (draft) => {
		const value = Number(draft);
		if (!Number.isFinite(value)) throw new Error("expected finite number");
		return value;
	},
};

export const pathField: HepiSettingField<string> = {
	id: "root",
	label: "Root path",
	type: "path",
	defaultValue: "/tmp",
	description: "Set the filesystem root used by path setting behavior tests.",
	parse: (draft) => draft,
};

export const settingsFields = [booleanField, enumField, textField, numberField, pathField] as const;

export const generalGroup: HepiSettingGroup = {
	id: "general",
	title: "General",
	description: "General settings",
	fields: settingsFields,
};

export const advancedGroup: HepiSettingGroup = {
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
	overrides: Partial<HepiSettingsProvider> = {},
): HepiSettingsProvider {
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
