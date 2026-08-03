import {
	defaultPiSettingsPaths,
	type HepiSettingField,
	type HepiSettingsProvider,
	type HepiSettingsState,
	readJsonSettingsRoot,
	updateJsonSettingsRoot,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { MCTX_SETTINGS_SECTION } from "./config.js";
import { validModelRef } from "./model-ref.js";

export const MCTX_HISTORIAN_SETTINGS_PROVIDER_ID = "pi-mctx-historian";
export const MCTX_HISTORIAN_SETTINGS_GROUP = "historian";

export interface MctxHistorianSettings {
	readonly enabled: boolean;
	readonly model: string;
}

export interface MctxHistorianSettingsProviderOptions {
	/** User-level Pi settings path; override only for tests or an embedding host. */
	readonly path?: string;
}

const opaqueSettingsObjectSchema = Type.Record(Type.String(), Type.Unknown());
type OpaqueSettingsObject = Static<typeof opaqueSettingsObjectSchema>;

function parseSettingsObject(value: unknown, message: string): OpaqueSettingsObject {
	if (!Value.Check(opaqueSettingsObjectSchema, value)) throw new Error(message);
	return value;
}

function settingsFromState(state: HepiSettingsState): MctxHistorianSettings {
	const values = state[MCTX_HISTORIAN_SETTINGS_GROUP];
	return {
		enabled: values?.enabled === true,
		model: typeof values?.model === "string" ? values.model.trim() : "",
	};
}

const enabledField: HepiSettingField<boolean> = {
	id: "enabled",
	label: "Historian",
	type: "boolean",
	defaultValue: false,
	description: "Enable Magic Context historian processing after the next Pi reload.",
	parse: (draft): boolean => {
		if (draft === "true") return true;
		if (draft === "false") return false;
		throw new Error("Expected true or false");
	},
};

const modelField: HepiSettingField<string> = {
	id: "model",
	label: "Historian model",
	type: "text",
	defaultValue: "",
	description: "Select the exact provider/model used for bounded historian completions.",
	formatDisplay: (value): string => value || "Not selected",
	parse: (draft): string => draft.trim(),
	validate: (value): string | undefined =>
		validModelRef(value) ? undefined : "Expected an exact provider/model reference",
	enabled: (state): boolean => state[MCTX_HISTORIAN_SETTINGS_GROUP]?.enabled === true,
};

/** Creates the reload-only Settings contribution for MCTX historian admission. */
export function createMctxHistorianSettingsProvider(
	options: MctxHistorianSettingsProviderOptions = {},
): HepiSettingsProvider {
	const resolvePath = (): string => options.path ?? defaultPiSettingsPaths().globalPath;
	return {
		id: MCTX_HISTORIAN_SETTINGS_PROVIDER_ID,
		title: "Magic Context Historian",
		moduleName: "pi-mctx",
		origin: "@hheei/pi-mctx",
		description: "Historian enablement and model selection for Magic Context.",
		groups: [
			{
				id: MCTX_HISTORIAN_SETTINGS_GROUP,
				title: "",
				fields: [enabledField, modelField],
			},
		],
		storage: {
			async load(context): Promise<HepiSettingsState> {
				const path = resolvePath();
				const root = await readJsonSettingsRoot(path, context.signal);
				const rawSection = root[MCTX_SETTINGS_SECTION];
				const section =
					rawSection === undefined
						? undefined
						: parseSettingsObject(
								rawSection,
								`Expected ${MCTX_SETTINGS_SECTION} to be an object in ${path}`,
							);
				const rawHistorian = section?.historian;
				const historian =
					rawHistorian === undefined
						? undefined
						: parseSettingsObject(
								rawHistorian,
								`Expected ${MCTX_SETTINGS_SECTION}.historian to be an object in ${path}`,
							);
				return {
					[MCTX_HISTORIAN_SETTINGS_GROUP]: {
						enabled: section?.enabled === true,
						model: typeof historian?.model === "string" ? historian.model : "",
					},
				};
			},
			async validate(state): Promise<void> {
				const settings = settingsFromState(state);
				if (settings.enabled && !validModelRef(settings.model))
					throw new Error("Historian model must be an exact provider/model reference");
			},
			async save(state, context): Promise<void> {
				const settings = settingsFromState(state);
				const path = resolvePath();
				await updateJsonSettingsRoot(
					path,
					(root) => {
						const rawSection = root[MCTX_SETTINGS_SECTION];
						const section = {
							...(rawSection === undefined
								? {}
								: parseSettingsObject(
										rawSection,
										`Expected ${MCTX_SETTINGS_SECTION} to be an object in ${path}`,
									)),
						};
						const rawHistorian = section.historian;
						const historian =
							rawHistorian === undefined
								? {}
								: parseSettingsObject(
										rawHistorian,
										`Expected ${MCTX_SETTINGS_SECTION}.historian to be an object in ${path}`,
									);
						section.enabled = settings.enabled;
						if (settings.model !== "") section.historian = { ...historian, model: settings.model };
						root[MCTX_SETTINGS_SECTION] = section;
					},
					context.signal,
				);
			},
		},
	};
}
