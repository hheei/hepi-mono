import {
	createHepiModelSelectionField,
	defaultPiSettingsPaths,
	type HepiModelSelectionOption,
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

export const MCTX_SETTINGS_PROVIDER_ID = "pi-mctx";
export const MCTX_RUNTIME_SETTINGS_GROUP = "runtime";
export const MCTX_HISTORIAN_SETTINGS_GROUP = "historian";

export interface MctxSettings {
	readonly runtimeEnabled: boolean;
	readonly smartDrops: boolean;
	readonly historianEnabled: boolean;
	readonly model: string;
}

export interface MctxSettingsProviderOptions {
	/** User-level Pi settings path; override only for tests or an embedding host. */
	readonly path?: string;
	readonly modelOptions?: readonly HepiModelSelectionOption[];
}

const opaqueSettingsObjectSchema = Type.Record(Type.String(), Type.Unknown());
type OpaqueSettingsObject = Static<typeof opaqueSettingsObjectSchema>;

function parseSettingsObject(value: unknown, message: string): OpaqueSettingsObject {
	if (!Value.Check(opaqueSettingsObjectSchema, value)) throw new Error(message);
	return value;
}

function settingsFromState(state: HepiSettingsState): MctxSettings {
	const runtime = state[MCTX_RUNTIME_SETTINGS_GROUP];
	const historian = state[MCTX_HISTORIAN_SETTINGS_GROUP];
	return {
		runtimeEnabled: runtime?.enabled === true,
		smartDrops: runtime?.smartDrops === true,
		historianEnabled: historian?.enabled === true,
		model: typeof historian?.model === "string" ? historian.model.trim() : "",
	};
}

const runtimeEnabledField: HepiSettingField<boolean> = {
	id: "enabled",
	label: "Magic Context",
	type: "boolean",
	defaultValue: false,
	description: "Enable Magic Context runtime processing after the next Pi reload.",
	parse: (draft): boolean => {
		if (draft === "true") return true;
		if (draft === "false") return false;
		throw new Error("Expected true or false");
	},
};

const smartDropsField: HepiSettingField<boolean> = {
	id: "smartDrops",
	label: "Smart drops",
	type: "boolean",
	defaultValue: false,
	description:
		"Automatically reclaim old tool results under context pressure after the next Pi reload.",
	parse: (draft): boolean => {
		if (draft === "true") return true;
		if (draft === "false") return false;
		throw new Error("Expected true or false");
	},
	enabled: (state): boolean => state[MCTX_RUNTIME_SETTINGS_GROUP]?.enabled === true,
};

const historianEnabledField: HepiSettingField<boolean> = {
	id: "enabled",
	label: "Historian",
	type: "boolean",
	defaultValue: false,
	description: "Enable historian compartment processing after the next Pi reload.",
	parse: (draft): boolean => {
		if (draft === "true") return true;
		if (draft === "false") return false;
		throw new Error("Expected true or false");
	},
	enabled: (state): boolean => state[MCTX_RUNTIME_SETTINGS_GROUP]?.enabled === true,
};

function createModelField(
	modelOptions: readonly HepiModelSelectionOption[],
): HepiSettingField<string> {
	return {
		...createHepiModelSelectionField({
			id: "model",
			label: "Historian model",
			description: "Select the exact provider/model used for bounded historian completions.",
			modelOptions,
			thinking: "off",
		}),
		parse: (draft): string => draft.trim(),
		validate: (value): string | undefined =>
			validModelRef(value) ? undefined : "Expected an exact provider/model reference",
		enabled: (state): boolean =>
			state[MCTX_RUNTIME_SETTINGS_GROUP]?.enabled === true &&
			state[MCTX_HISTORIAN_SETTINGS_GROUP]?.enabled === true,
	};
}

/** Creates the reload-only Settings contribution for MCTX runtime and historian admission. */
export function createMctxSettingsProvider(
	options: MctxSettingsProviderOptions = {},
): HepiSettingsProvider {
	const resolvePath = (): string => options.path ?? defaultPiSettingsPaths().globalPath;
	const modelField = createModelField(options.modelOptions ?? [{ value: "", label: "Not set" }]);
	return {
		id: MCTX_SETTINGS_PROVIDER_ID,
		title: "Magic Context",
		moduleName: "pi-mctx",
		origin: "@hheei/pi-mctx",
		description:
			"Magic Context runtime, automatic reclaim, historian enablement, and model selection.",
		groups: [
			{
				id: MCTX_RUNTIME_SETTINGS_GROUP,
				title: "",
				fields: [runtimeEnabledField, smartDropsField],
			},
			{
				id: MCTX_HISTORIAN_SETTINGS_GROUP,
				title: "",
				fields: [historianEnabledField, modelField],
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
					[MCTX_RUNTIME_SETTINGS_GROUP]: {
						enabled: section?.enabled === true,
						smartDrops: section?.smart_drops === true,
					},
					[MCTX_HISTORIAN_SETTINGS_GROUP]: {
						enabled: historian?.enabled === true,
						model: typeof historian?.model === "string" ? historian.model : "",
					},
				};
			},
			async validate(state): Promise<void> {
				const settings = settingsFromState(state);
				if (settings.runtimeEnabled && settings.historianEnabled && !validModelRef(settings.model))
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
						section.enabled = settings.runtimeEnabled;
						section.smart_drops = settings.smartDrops;
						section.historian = {
							...historian,
							enabled: settings.historianEnabled,
							...(settings.model === "" ? {} : { model: settings.model }),
						};
						root[MCTX_SETTINGS_SECTION] = section;
					},
					context.signal,
				);
			},
		},
	};
}
