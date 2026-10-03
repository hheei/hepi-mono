import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createJsonSettingsStorage,
	type ExtensionLifecycleContext,
	getRuntimeSettingsRegistry,
	isSubagentProcess,
	registerExtensionLifecycle,
	registerSettings,
	type SettingsProvider,
	type SettingsState,
	type ToolCollapseMode,
	type ToolTui,
} from "@hheei/pi-ext-core";

const GROUP = "toolTui";
const FIELD = "collapseMode";
const SUBAGENT_FIELD = "subagentCollapseMode";
const MODES: readonly ToolCollapseMode[] = ["auto", "on", "pertrace", "off"];

export const DEFAULT_TOOL_COLLAPSE_MODE: ToolCollapseMode = "auto";
export const DEFAULT_SUBAGENT_TOOL_COLLAPSE_MODE: ToolCollapseMode = "off";

const DESCRIPTION =
	"auto collapses a long tool 15 seconds after it completes; on collapses immediately and suppresses Bash streaming; pertrace keeps the current next-turn rule; off never auto-collapses. Ctrl+O still expands everything.";
const FIELD_DESCRIPTION =
	"Choose how completed long tool output frames fold. Options are auto, on, pertrace, and off.";
const SUBAGENT_FIELD_DESCRIPTION =
	"Choose tool output display mode for subagents. off defaults to fully collapsed (immediate collapse). Options are off, auto, on, and pertrace.";

function collapseModeFromValue(value: unknown): ToolCollapseMode {
	return MODES.find((mode) => mode === value) ?? DEFAULT_TOOL_COLLAPSE_MODE;
}

/**
 * Resolves the effective ToolCollapseMode applied to the shared ToolTui.
 * In subagents, "off" represents turning off tool display, which defaults to fully collapsed ("on").
 */
export function resolveEffectiveCollapseMode(
	mode: ToolCollapseMode,
	isSubagent: boolean,
): ToolCollapseMode {
	if (isSubagent && mode === "off") {
		return "on";
	}
	return mode;
}

export interface ToolTuiSettingsProviderOptions {
	readonly path?: string;
	readonly apply: (mode: ToolCollapseMode) => void;
	readonly env?: NodeJS.ProcessEnv;
}

export function createToolTuiSettingsProvider(
	options: ToolTuiSettingsProviderOptions,
): SettingsProvider {
	const isSubagent = isSubagentProcess(options.env);
	return {
		id: "pi-ext-tools.tool-tui",
		title: "Tool Output",
		origin: "@hheei/pi-ext-tools",
		description: DESCRIPTION,
		groups: [
			{
				id: GROUP,
				title: "",
				fields: [
					{
						id: FIELD,
						label: "Auto-collapse",
						type: "enum",
						defaultValue: DEFAULT_TOOL_COLLAPSE_MODE,
						description: FIELD_DESCRIPTION,
						options: MODES.map((mode) => ({ value: mode })),
						parse: (value) => collapseModeFromValue(value),
						validate: (value) =>
							MODES.includes(value as ToolCollapseMode)
								? undefined
								: "Auto-collapse must be auto, on, pertrace, or off",
					},
					{
						id: SUBAGENT_FIELD,
						label: "Subagent tool display",
						type: "enum",
						defaultValue: DEFAULT_SUBAGENT_TOOL_COLLAPSE_MODE,
						description: SUBAGENT_FIELD_DESCRIPTION,
						options: MODES.map((mode) => ({ value: mode })),
						parse: (value) => collapseModeFromValue(value),
						validate: (value) =>
							MODES.includes(value as ToolCollapseMode)
								? undefined
								: "Subagent tool display must be auto, on, pertrace, or off",
					},
				],
			},
		],
		storage: createJsonSettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			group: GROUP,
		}),
		onChange: (change) => {
			if (isSubagent) {
				if (change.fieldId === SUBAGENT_FIELD) {
					options.apply(resolveEffectiveCollapseMode(collapseModeFromValue(change.value), true));
				}
				return;
			}
			if (change.fieldId !== FIELD) return;
			options.apply(resolveEffectiveCollapseMode(collapseModeFromValue(change.value), false));
		},
	};
}

/** Saved mode wins; in subagent processes, defaults to "off" (mapped to immediate collapse). */
export function readToolCollapseMode(
	state: SettingsState | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ToolCollapseMode {
	const isSubagent = isSubagentProcess(env);
	if (isSubagent) {
		const raw = state?.[GROUP]?.[SUBAGENT_FIELD];
		const mode =
			raw === undefined ? DEFAULT_SUBAGENT_TOOL_COLLAPSE_MODE : collapseModeFromValue(raw);
		return resolveEffectiveCollapseMode(mode, true);
	}
	return collapseModeFromValue(state?.[GROUP]?.[FIELD]);
}

/**
 * Owns the Tool Output settings group and applies the saved mode to the shared
 * ToolTui. The provider is session-scoped, so a mode change applies immediately
 * and a reload re-reads the persisted value.
 */
export function registerToolTuiLifecycle(pi: ExtensionAPI, tui: ToolTui): void {
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-ext-tools/tool-tui",
		start: async ({ extension, resources, signal }: ExtensionLifecycleContext) => {
			const provider = createToolTuiSettingsProvider({
				apply: (mode) => tui.setToolCollapseMode(mode),
			});
			resources.add(
				"tool-tui-settings",
				registerSettings(provider, getRuntimeSettingsRegistry(pi)),
			);
			const state = await provider.storage.load({
				sessionId: extension.sessionManager.getSessionId(),
				cwd: extension.cwd,
				signal,
			});
			signal.throwIfAborted();
			tui.setToolCollapseMode(readToolCollapseMode(state));
		},
	});
}
