import {
	defaultPiSettingsPaths,
	type HepiSettingsProvider,
	type HepiSettingsState,
	readJsonSettingsRoot,
	updateJsonSettingsRoot,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const TRADITIONAL_TO_SIMPLIFIED_GROUP = "traditional-to-simplified";
export const TRADITIONAL_TO_SIMPLIFIED_FIELD = "mode";

const modeSchema = Type.Union([Type.Literal("t2s"), Type.Literal("off")]);
const valuesSchema = Type.Object({ mode: modeSchema }, { additionalProperties: false });
const objectSchema = Type.Record(Type.String(), Type.Unknown());
type Values = Static<typeof valuesSchema>;
type JsonObject = Static<typeof objectSchema>;
type Mode = Values["mode"];
const sectionName = "pi-t2s";
const legacySectionName = "pi-basics";

function values(value: unknown, label: string): Values {
	if (!Value.Check(valuesSchema, value)) throw new Error(`Invalid ${label} settings`);
	return value;
}

function section(root: JsonObject, name: string): JsonObject | undefined {
	const value = root[name];
	if (value === undefined) return undefined;
	if (!Value.Check(objectSchema, value))
		throw new Error(`Expected ${name} settings to be an object`);
	return value;
}

function storedValues(root: JsonObject, name: string): Values | undefined {
	const value = section(root, name)?.[TRADITIONAL_TO_SIMPLIFIED_GROUP];
	return value === undefined
		? undefined
		: values(value, `${name}.${TRADITIONAL_TO_SIMPLIFIED_GROUP}`);
}

export function traditionalToSimplifiedEnabled(state: HepiSettingsState): boolean {
	return state[TRADITIONAL_TO_SIMPLIFIED_GROUP]?.[TRADITIONAL_TO_SIMPLIFIED_FIELD] !== "off";
}

export function createTraditionalToSimplifiedSettingsProvider(
	options: { readonly path?: string } = {},
): HepiSettingsProvider {
	const path = options.path ?? defaultPiSettingsPaths().globalPath;
	return {
		id: "pi-t2s",
		title: "Traditional to simplified",
		origin: "@hheei/pi-t2s",
		groups: [
			{
				id: TRADITIONAL_TO_SIMPLIFIED_GROUP,
				title: "",
				fields: [
					{
						id: TRADITIONAL_TO_SIMPLIFIED_FIELD,
						label: "ZH translate",
						type: "enum",
						defaultValue: "t2s",
						options: [
							{ value: "t2s", label: "t2s" },
							{ value: "off", label: "off" },
						],
						description: "Convert interactive Traditional Chinese input to Simplified Chinese.",
						parse: (draft) => (draft === "off" ? "off" : "t2s"),
					},
				],
			},
		],
		storage: {
			async load(context) {
				const root = await readJsonSettingsRoot(path, context.signal);
				const owned = storedValues(root, sectionName);
				if (owned !== undefined) return { [TRADITIONAL_TO_SIMPLIFIED_GROUP]: owned };
				if (storedValues(root, legacySectionName) === undefined) return undefined;
				let migrated: Values | undefined;
				await updateJsonSettingsRoot(
					path,
					(next) => {
						const currentOwned = storedValues(next, sectionName);
						if (currentOwned !== undefined) {
							migrated = currentOwned;
							return;
						}
						const currentLegacy = storedValues(next, legacySectionName);
						if (currentLegacy === undefined) return;
						const legacy = section(next, legacySectionName);
						if (legacy === undefined) return;
						const { [TRADITIONAL_TO_SIMPLIFIED_GROUP]: _, ...legacySiblings } = legacy;
						next[legacySectionName] = legacySiblings;
						next[sectionName] = {
							...(section(next, sectionName) ?? {}),
							[TRADITIONAL_TO_SIMPLIFIED_GROUP]: currentLegacy,
						};
						migrated = currentLegacy;
					},
					context.signal,
				);
				return migrated === undefined ? undefined : { [TRADITIONAL_TO_SIMPLIFIED_GROUP]: migrated };
			},
			async save(state: HepiSettingsState, context) {
				const mode: Mode = values(state[TRADITIONAL_TO_SIMPLIFIED_GROUP], "saved").mode;
				await updateJsonSettingsRoot(
					path,
					(root) => {
						root[sectionName] = {
							...(section(root, sectionName) ?? {}),
							[TRADITIONAL_TO_SIMPLIFIED_GROUP]: { mode },
						};
					},
					context.signal,
				);
			},
		},
	};
}
