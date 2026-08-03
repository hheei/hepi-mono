import {
	createJsonSectionSettingsStorage,
	type HepiContext,
	type HepiSettingField,
	type HepiSettingOption,
	type HepiSettingsProvider,
	type HepiSettingsState,
	type HepiSettingValue,
} from "@hheei/pi-ext-core";
import type { JoinMode, WidgetMode } from "./types.js";

const SETTINGS_GROUP = "runtime";
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;

export type ToolDescriptionMode = "full" | "compact" | "custom";

export interface SubagentsSettings {
	maxConcurrent?: number;
	defaultMaxTurns?: number;
	graceTurns?: number;
	defaultJoinMode?: JoinMode;
	schedulingEnabled?: boolean;
	scopeModels?: boolean;
	disableDefaultAgents?: boolean;
	toolDescriptionMode?: ToolDescriptionMode;
	widgetMode?: WidgetMode;
	outputTranscript?: boolean;
}

export interface SettingsAppliers {
	setMaxConcurrent: (value: number) => void;
	setDefaultMaxTurns: (value: number) => void;
	setGraceTurns: (value: number) => void;
	setDefaultJoinMode: (mode: JoinMode) => void;
	setSchedulingEnabled: (enabled: boolean) => void;
	setScopeModels: (enabled: boolean) => void;
	setDisableDefaultAgents: (enabled: boolean) => void;
	setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
	setWidgetMode: (mode: WidgetMode) => void;
	setOutputTranscript: (enabled: boolean) => void;
}

export type SettingsEmit = (event: string, payload: unknown) => void;

export interface SubagentsSettingsProviderOptions {
	readonly path?: string;
}

const VALID_JOIN_MODES: ReadonlySet<JoinMode> = new Set(["async", "group", "smart"]);
const VALID_TOOL_DESCRIPTION_MODES: ReadonlySet<ToolDescriptionMode> = new Set([
	"full",
	"compact",
	"custom",
]);
const VALID_WIDGET_MODES: ReadonlySet<WidgetMode> = new Set(["all", "background", "off"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
	);
}

function sanitize(raw: unknown): SubagentsSettings {
	if (!isRecord(raw)) return {};
	const result: SubagentsSettings = {};
	if (integerInRange(raw.maxConcurrent, 1, MAX_CONCURRENT_CEILING))
		result.maxConcurrent = raw.maxConcurrent;
	if (integerInRange(raw.defaultMaxTurns, 1, MAX_TURNS_CEILING))
		result.defaultMaxTurns = raw.defaultMaxTurns;
	if (raw.graceTurns === 5) result.graceTurns = 5;
	if (
		typeof raw.defaultJoinMode === "string" &&
		VALID_JOIN_MODES.has(raw.defaultJoinMode as JoinMode)
	)
		result.defaultJoinMode = raw.defaultJoinMode as JoinMode;
	if (typeof raw.schedulingEnabled === "boolean") result.schedulingEnabled = raw.schedulingEnabled;
	if (typeof raw.scopeModels === "boolean") result.scopeModels = raw.scopeModels;
	if (typeof raw.disableDefaultAgents === "boolean")
		result.disableDefaultAgents = raw.disableDefaultAgents;
	if (
		typeof raw.toolDescriptionMode === "string" &&
		VALID_TOOL_DESCRIPTION_MODES.has(raw.toolDescriptionMode as ToolDescriptionMode)
	)
		result.toolDescriptionMode = raw.toolDescriptionMode as ToolDescriptionMode;
	if (typeof raw.widgetMode === "string" && VALID_WIDGET_MODES.has(raw.widgetMode as WidgetMode))
		result.widgetMode = raw.widgetMode as WidgetMode;
	if (typeof raw.outputTranscript === "boolean") result.outputTranscript = raw.outputTranscript;
	return result;
}

function storage(options: SubagentsSettingsProviderOptions = {}) {
	return createJsonSectionSettingsStorage({
		...(options.path === undefined ? {} : { path: options.path }),
		section: "pi-subagents",
		group: SETTINGS_GROUP,
	});
}

function settingsFromState(state: HepiSettingsState | undefined): SubagentsSettings {
	return sanitize(state?.[SETTINGS_GROUP]);
}

function numberField(
	id: string,
	label: string,
	description: string,
	defaultValue: number,
	minimum: number,
	maximum: number,
): HepiSettingField<number> {
	return {
		id,
		label,
		type: "number",
		defaultValue,
		description,
		parse: (value) => Number(value.trim()),
		validate: (value) =>
			integerInRange(value, minimum, maximum)
				? undefined
				: `Enter an integer from ${minimum} to ${maximum}.`,
	};
}

function booleanField(
	id: string,
	label: string,
	description: string,
	defaultValue: boolean,
): HepiSettingField<boolean> {
	return {
		id,
		label,
		type: "boolean",
		defaultValue,
		description,
		parse: (value) => value === "true",
	};
}

function enumField<T extends string>(
	id: string,
	label: string,
	description: string,
	defaultValue: T,
	options: readonly T[],
): HepiSettingField<T> {
	const settingOptions: readonly HepiSettingOption<T>[] = options.map((value) => ({
		value,
		label: value,
	}));
	return {
		id,
		label,
		type: "enum",
		defaultValue,
		description,
		options: settingOptions,
		parse: (value) => value as T,
		validate: (value) => (options.includes(value) ? undefined : "Choose one of the listed values."),
	};
}

export function createSubagentsSettingsProvider(
	options: SubagentsSettingsProviderOptions = {},
): HepiSettingsProvider {
	return {
		id: "pi-subagents",
		title: "Subagents",
		origin: "@hheei/pi-subagents",
		description:
			"Configure subagent defaults and presentation; execution remains core-coordinated.",
		groups: [
			{
				id: SETTINGS_GROUP,
				title: "Runtime",
				fields: [
					numberField(
						"maxConcurrent",
						"Max concurrency",
						"Maximum active child turns admitted by core for this session.",
						2,
						1,
						MAX_CONCURRENT_CEILING,
					),
					numberField(
						"defaultMaxTurns",
						"Default max turns",
						"Finite default used when an agent profile does not pin its turn budget.",
						50,
						1,
						MAX_TURNS_CEILING,
					),
					{
						...numberField(
							"graceTurns",
							"Grace turns",
							"Core-owned wrap-up grace; this value is fixed at five turns.",
							5,
							5,
							5,
						),
						enabled: () => false,
					},
					enumField(
						"defaultJoinMode",
						"Join mode",
						"Default grouping policy for background completion notifications.",
						"smart",
						["smart", "async", "group"],
					),
					booleanField(
						"schedulingEnabled",
						"Scheduling",
						"Allow scheduled subagent jobs to be registered for this session.",
						true,
					),
					booleanField(
						"scopeModels",
						"Scope models",
						"Validate selected subagent models against Pi's enabled model allowlist.",
						false,
					),
					booleanField(
						"disableDefaultAgents",
						"Disable defaults",
						"Hide built-in profiles while keeping user-defined profiles available.",
						false,
					),
					enumField(
						"toolDescriptionMode",
						"Tool description",
						"Choose the amount of Agent tool guidance shown to the model.",
						"full",
						["full", "compact", "custom"],
					),
					enumField(
						"widgetMode",
						"Widget",
						"Choose which active agents appear in the parent editor widget.",
						"background",
						["all", "background", "off"],
					),
					booleanField(
						"outputTranscript",
						"Output transcript",
						"Write bounded JSONL transcripts for subagent runs by default.",
						true,
					),
				],
			},
		],
		storage: storage(options),
	};
}

export async function loadSettings(
	context: HepiContext,
	options: SubagentsSettingsProviderOptions = {},
): Promise<SubagentsSettings> {
	return settingsFromState(await storage(options).load(context));
}

export async function saveSettings(
	settings: SubagentsSettings,
	context: HepiContext,
	options: SubagentsSettingsProviderOptions = {},
): Promise<boolean> {
	try {
		const normalized = sanitize(settings);
		const values: Record<string, HepiSettingValue> = {};
		for (const [key, value] of Object.entries(normalized)) {
			if (value !== undefined) values[key] = value;
		}
		await storage(options).save({ [SETTINGS_GROUP]: values }, context);
		return true;
	} catch {
		return false;
	}
}

export function applySettings(settings: SubagentsSettings, appliers: SettingsAppliers): void {
	if (typeof settings.maxConcurrent === "number") appliers.setMaxConcurrent(settings.maxConcurrent);
	if (typeof settings.defaultMaxTurns === "number")
		appliers.setDefaultMaxTurns(settings.defaultMaxTurns);
	if (settings.graceTurns === 5) appliers.setGraceTurns(5);
	if (settings.defaultJoinMode !== undefined) appliers.setDefaultJoinMode(settings.defaultJoinMode);
	if (typeof settings.schedulingEnabled === "boolean")
		appliers.setSchedulingEnabled(settings.schedulingEnabled);
	if (typeof settings.scopeModels === "boolean") appliers.setScopeModels(settings.scopeModels);
	if (typeof settings.disableDefaultAgents === "boolean")
		appliers.setDisableDefaultAgents(settings.disableDefaultAgents);
	if (settings.toolDescriptionMode !== undefined)
		appliers.setToolDescriptionMode(settings.toolDescriptionMode);
	if (settings.widgetMode !== undefined) appliers.setWidgetMode(settings.widgetMode);
	if (typeof settings.outputTranscript === "boolean")
		appliers.setOutputTranscript(settings.outputTranscript);
}

export function persistToastFor(
	successMsg: string,
	persisted: boolean,
): { message: string; level: "info" | "warning" } {
	return persisted
		? { message: successMsg, level: "info" }
		: { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

export async function applyAndEmitLoaded(
	appliers: SettingsAppliers,
	emit: SettingsEmit,
	context: HepiContext,
	options: SubagentsSettingsProviderOptions = {},
): Promise<SubagentsSettings> {
	const settings = await loadSettings(context, options);
	applySettings(settings, appliers);
	emit("subagents:settings_loaded", { settings });
	return settings;
}

export async function saveAndEmitChanged(
	snapshot: SubagentsSettings,
	successMsg: string,
	emit: SettingsEmit,
	context: HepiContext,
	options: SubagentsSettingsProviderOptions = {},
): Promise<{ message: string; level: "info" | "warning" }> {
	const persisted = await saveSettings(snapshot, context, options);
	emit("subagents:settings_changed", { settings: snapshot, persisted });
	return persistToastFor(successMsg, persisted);
}
