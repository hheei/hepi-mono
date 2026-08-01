import {
	createJsonSectionSettingsStorage,
	type HepiSettingsProvider,
	type HepiSettingsState,
} from "@hheei/pi-ext-core";

const GROUP = "features";

export interface FffSettingsProviderOptions {
	readonly path?: string;
}

export interface FffSettings {
	/** FFF behavior toggles only; tool activation belongs to pi-loadout. */
	readonly autocomplete: boolean;
	readonly readEnhancement: boolean;
	readonly grepEnhancement: boolean;
	readonly statusUI: boolean;
}

export const DEFAULT_FFF_SETTINGS: FffSettings = {
	autocomplete: true,
	readEnhancement: true,
	grepEnhancement: true,
	statusUI: true,
};

function booleanAt(state: HepiSettingsState | undefined, key: keyof FffSettings): boolean {
	const value = state?.[GROUP]?.[key];
	return typeof value === "boolean" ? value : DEFAULT_FFF_SETTINGS[key];
}

export function fffSettingsFromState(state: HepiSettingsState | undefined): FffSettings {
	return {
		autocomplete: booleanAt(state, "autocomplete"),
		readEnhancement: booleanAt(state, "readEnhancement"),
		grepEnhancement: booleanAt(state, "grepEnhancement"),
		statusUI: booleanAt(state, "statusUI"),
	};
}

export function createFffSettingsProvider(
	options: FffSettingsProviderOptions = {},
): HepiSettingsProvider {
	const storage = createJsonSectionSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
		section: "pi-fff",
		group: GROUP,
	});
	return {
		id: "pi-fff",
		title: "FFF",
		origin: "@hheei/pi-fff",
		description: "Configure FFF runtime behavior. Tool activation remains owned by Loadout.",
		groups: [
			{
				id: GROUP,
				title: "",
				fields: [
					{
						id: "autocomplete",
						label: "Autocomplete",
						type: "boolean",
						defaultValue: true,
						description:
							"Use the FFF index for @path autocomplete while preserving other autocomplete providers.",
						parse: (value) => value === "true",
					},
					{
						id: "readEnhancement",
						label: "Read enhancement",
						type: "boolean",
						defaultValue: true,
						description:
							"Resolve approximate file paths with FFF before delegating the read operation to Pi.",
						parse: (value) => value === "true",
					},
					{
						id: "grepEnhancement",
						label: "Grep enhancement",
						type: "boolean",
						defaultValue: true,
						description:
							"Use FFF content search when its semantics are compatible with the requested grep operation.",
						parse: (value) => value === "true",
					},
					{
						id: "statusUI",
						label: "Status notices",
						type: "boolean",
						defaultValue: true,
						description:
							"Show FFF startup availability and indexing notices in the current Pi session.",
						parse: (value) => value === "true",
					},
				],
			},
		],
		storage,
	};
}
