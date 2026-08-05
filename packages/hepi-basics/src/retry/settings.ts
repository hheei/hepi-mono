import {
	createJsonSectionSettingsStorage,
	type HepiSettingField,
	type HepiSettingsProvider,
	type HepiSettingsState,
} from "../core/index.js";

export const RETRY_SETTINGS_GROUP = "retry";
const SETTINGS_SECTION = "hepi";
export const DEFAULT_RETRY_STALL_TIMEOUT_MS = 90_000;

export interface RetrySettings {
	readonly enabled: boolean;
	readonly stallTimeoutMs: number;
}

export interface RetrySettingsProviderOptions {
	readonly path?: string;
}

export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
	enabled: true,
	stallTimeoutMs: DEFAULT_RETRY_STALL_TIMEOUT_MS,
};

function normalizeStallTimeoutMs(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: DEFAULT_RETRY_STALL_TIMEOUT_MS;
}

export function retrySettings(state: HepiSettingsState): RetrySettings {
	const values = state[RETRY_SETTINGS_GROUP];
	return {
		enabled: values?.enabled !== false,
		stallTimeoutMs: normalizeStallTimeoutMs(values?.stallTimeoutMs),
	};
}

const enabledField: HepiSettingField<boolean> = {
	id: "enabled",
	label: "Retry helpers",
	type: "boolean",
	defaultValue: true,
	description: "Classify supported provider failures and recover stalled provider streams.",
	parse: (draft) => {
		if (draft === "true") return true;
		if (draft === "false") return false;
		throw new Error("Expected true or false");
	},
};

const stallTimeoutField: HepiSettingField<number> = {
	id: "stallTimeoutMs",
	label: "Stall timeout ms",
	type: "number",
	defaultValue: DEFAULT_RETRY_STALL_TIMEOUT_MS,
	description: "Abort a stalled provider stream after this many milliseconds; use zero to disable.",
	parse: (draft) => Number(draft),
	validate: (value) =>
		Number.isSafeInteger(value) && value >= 0
			? undefined
			: "Expected a non-negative whole number of milliseconds",
};

const fields: readonly HepiSettingField[] = [enabledField, stallTimeoutField];

export function createRetrySettingsProvider(
	options: RetrySettingsProviderOptions = {},
): HepiSettingsProvider {
	return {
		id: "pi-basics-retry",
		title: "Retry",
		origin: "@hheei/hepi-basics",
		description: "Provider error classification and stalled-stream recovery.",
		groups: [{ id: RETRY_SETTINGS_GROUP, title: "", fields }],
		storage: createJsonSectionSettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			section: SETTINGS_SECTION,
			group: RETRY_SETTINGS_GROUP,
		}),
	};
}
