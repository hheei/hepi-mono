import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createJsonSettingsStorage,
	type ExtensionLifecycleContext,
	getRuntimeSettingsRegistry,
	registerExtensionLifecycle,
	registerSettings,
	type SettingsProvider,
	type SettingsState,
	type ToolCollapseMode,
	type ToolTui,
} from "@hheei/pi-ext-core";

const GROUP = "toolTui";
const FIELD = "collapseMode";
const MODES: readonly ToolCollapseMode[] = ["auto", "on", "pertrace", "off"];

export const DEFAULT_TOOL_COLLAPSE_MODE: ToolCollapseMode = "auto";

const DESCRIPTION =
	"auto collapses a long tool 15 seconds after it completes; on collapses immediately and suppresses Bash streaming; pertrace keeps the current next-turn rule; off never auto-collapses. Ctrl+O still expands everything.";
const FIELD_DESCRIPTION =
	"Choose how completed long tool output frames fold. Options are auto, on, pertrace, and off.";

function collapseModeFromValue(value: unknown): ToolCollapseMode {
	return MODES.find((mode) => mode === value) ?? DEFAULT_TOOL_COLLAPSE_MODE;
}

export interface ToolTuiSettingsProviderOptions {
	readonly path?: string;
	readonly apply: (mode: ToolCollapseMode) => void;
}

export function createToolTuiSettingsProvider(
	options: ToolTuiSettingsProviderOptions,
): SettingsProvider {
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
				],
			},
		],
		storage: createJsonSettingsStorage({
			...(options.path === undefined ? {} : { path: options.path }),
			group: GROUP,
		}),
		onChange: (change) => {
			if (change.fieldId !== FIELD) return;
			options.apply(collapseModeFromValue(change.value));
		},
	};
}

/** Saved mode wins; a missing or unknown value keeps the `auto` default. */
export function readToolCollapseMode(state: SettingsState | undefined): ToolCollapseMode {
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
