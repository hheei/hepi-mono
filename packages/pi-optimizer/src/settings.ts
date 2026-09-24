import {
	defaultExtensionSettingsPaths,
	readJsonSettingsRoot,
	type SettingGroup,
	type SettingsProvider,
	updateJsonSettingsRoot,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { CAVEMAN_LEVELS } from "./caveman.js";
import { PONYTAIL_LEVELS } from "./ponytail.js";

const objectSchema = Type.Record(Type.String(), Type.Unknown());
const schema = Type.Object({
	t2s: Type.Object({ mode: Type.Enum(["t2s", "off"]) }, { additionalProperties: false }),
	caveman: Type.Object({ level: Type.Enum(CAVEMAN_LEVELS) }, { additionalProperties: false }),
	ponytail: Type.Object({ level: Type.Enum(PONYTAIL_LEVELS) }, { additionalProperties: false }),
	rtk: Type.Object(
		{ enabled: Type.Boolean(), path: Type.String() },
		{ additionalProperties: false },
	),
});
export type OptimizerSettings = Static<typeof schema>;
export type RtkSettings = OptimizerSettings["rtk"];
export const DEFAULT_OPTIMIZER_SETTINGS: OptimizerSettings = {
	t2s: { mode: "t2s" },
	caveman: { level: "off" },
	ponytail: { level: "off" },
	rtk: { enabled: false, path: "" },
};

export function parseOptimizerSettings(state: unknown): OptimizerSettings {
	if (state !== undefined && !Value.Check(objectSchema, state))
		throw new Error("Invalid pi-optimizer settings");
	const settings = { ...DEFAULT_OPTIMIZER_SETTINGS, ...state };
	if (!Value.Check(schema, settings)) throw new Error("Invalid pi-optimizer settings");
	return settings;
}

const modes = [
	{
		id: "t2s",
		title: "T2S",
		label: "T2S mode",
		field: "mode",
		values: ["t2s", "off"],
		description:
			"Convert interactive Traditional Chinese prose while preserving inline and fenced code.",
	},
	{
		id: "caveman",
		title: "Caveman",
		label: "Caveman mode",
		field: "level",
		values: CAVEMAN_LEVELS,
		description: "Control the Caveman prompt compression level used on subsequent agent turns.",
	},
	{
		id: "ponytail",
		title: "Ponytail",
		label: "Ponytail mode",
		field: "level",
		values: PONYTAIL_LEVELS,
		description: "Control the Ponytail prompt level used on subsequent agent turns.",
	},
] as const;
const groups: readonly SettingGroup[] = [
	...modes.map<SettingGroup>(({ id, title, label, field, values, description }) => ({
		id,
		title,
		fields: [
			{
				id: field,
				label,
				type: "enum",
				defaultValue: values[0],
				description,
				options: values.map((value) => ({ value, label: value })),
				parse: (draft) => draft,
			},
		],
	})),
	{
		id: "rtk",
		title: "RTK",
		fields: [
			{
				id: "enabled",
				label: "Enable RTK",
				type: "boolean",
				defaultValue: false,
				description:
					"Rewrite eligible local foreground Bash commands through RTK before they execute.",
				parse: (draft) => draft === "true",
			},
			{
				id: "path",
				label: "RTK path",
				type: "path",
				defaultValue: "",
				description:
					"Optional absolute or PATH-resolved executable used for RTK command rewrites. (auto) detects rtk on PATH.",
				format: (value) => (value ? String(value) : "(auto)"),
				parse: (draft) => draft.trim(),
			},
		],
	},
];

export function createOptimizerSettingsProvider(
	options: {
		readonly path?: string;
		readonly onSaved?: (settings: OptimizerSettings) => void;
	} = {},
): SettingsProvider {
	const path = options.path ?? defaultExtensionSettingsPaths().globalPath;
	return {
		id: "pi-optimizer",
		title: "Optimizer",
		origin: "@hheei/pi-optimizer",
		groups,
		storage: {
			async load(context): Promise<OptimizerSettings> {
				const root = await readJsonSettingsRoot(path, context.signal);
				return parseOptimizerSettings({
					...(root.t2s === undefined ? {} : { t2s: root.t2s }),
					...(root.caveman === undefined ? {} : { caveman: root.caveman }),
					...(root.ponytail === undefined ? {} : { ponytail: root.ponytail }),
					...(root.rtk === undefined ? {} : { rtk: root.rtk }),
				});
			},
			async save(state, context): Promise<void> {
				const settings = parseOptimizerSettings(state);
				await updateJsonSettingsRoot(
					path,
					(root) => {
						root.t2s = settings.t2s;
						root.caveman = settings.caveman;
						root.ponytail = settings.ponytail;
						root.rtk = settings.rtk;
					},
					context.signal,
				);
				options.onSaved?.(settings);
			},
		},
	};
}
