import {
	defaultPiSettingsPaths,
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

function section(root: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
	const value = root[name];
	if (value !== undefined && !Value.Check(objectSchema, value))
		throw new Error(`Invalid ${name} settings`);
	return value;
}

/** Mutates only the private snapshot; validation must finish before an atomic write. */
function migrate(root: Record<string, unknown>): { settings: OptimizerSettings; changed: boolean } {
	const owned = { ...section(root, "pi-optimizer") };
	let changed = false;
	if (owned.t2s === undefined) {
		for (const name of ["pi-t2s", "pi-basics"]) {
			const legacy = section(root, name);
			if (legacy?.["traditional-to-simplified"] === undefined) continue;
			owned.t2s = legacy["traditional-to-simplified"];
			delete legacy["traditional-to-simplified"];
			changed = true;
			break;
		}
	}
	if (owned.rtk === undefined) {
		const legacy = section(root, "pi-ext-tools");
		if (legacy && (legacy.rtk !== undefined || legacy.rtkPath !== undefined)) {
			owned.rtk = {
				enabled: legacy.rtk === undefined ? false : legacy.rtk,
				path: legacy.rtkPath === undefined ? "" : legacy.rtkPath,
			};
			delete legacy.rtk;
			delete legacy.rtkPath;
			changed = true;
		}
	}
	const settings = parseOptimizerSettings(owned);
	if (changed) root["pi-optimizer"] = owned;
	return { settings, changed };
}

const modes = [
	{
		id: "t2s",
		title: "T2S",
		field: "mode",
		values: ["t2s", "off"],
		description:
			"Convert interactive Traditional Chinese prose while preserving inline and fenced code.",
	},
	{
		id: "caveman",
		title: "Caveman",
		field: "level",
		values: CAVEMAN_LEVELS,
		description: "Control the Caveman prompt compression level used on subsequent agent turns.",
	},
	{
		id: "ponytail",
		title: "Ponytail",
		field: "level",
		values: PONYTAIL_LEVELS,
		description: "Control the Ponytail prompt level used on subsequent agent turns.",
	},
] as const;
const groups: readonly SettingGroup[] = [
	...modes.map<SettingGroup>(({ id, title, field, values, description }) => ({
		id,
		title,
		fields: [
			{
				id: field,
				label: "Mode",
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
				description: "Optional absolute or PATH-resolved executable used for RTK command rewrites.",
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
	const path = options.path ?? defaultPiSettingsPaths().globalPath;
	return {
		id: "pi-optimizer",
		title: "Optimizer",
		origin: "@hheei/pi-optimizer",
		groups,
		storage: {
			async load(context): Promise<OptimizerSettings> {
				let { settings, changed } = migrate(await readJsonSettingsRoot(path, context.signal));
				if (changed)
					await updateJsonSettingsRoot(
						path,
						(root) => {
							settings = migrate(root).settings;
						},
						context.signal,
					);
				return settings;
			},
			async save(state, context): Promise<void> {
				const settings = parseOptimizerSettings(state);
				await updateJsonSettingsRoot(
					path,
					(root) => {
						const existing = root["pi-optimizer"];
						root["pi-optimizer"] = {
							...(Value.Check(objectSchema, existing) ? existing : {}),
							...settings,
						};
					},
					context.signal,
				);
				options.onSaved?.(settings);
			},
		},
	};
}
