import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	createGroupedTogglePicker,
	type ExtensionSettingsSubpanel,
	registerExtensionSettings,
	type SettingGroup,
	type SettingsState,
} from "@hheei/pi-extcore";

let settings: PathShortcutSettings | undefined;

export default function piInturl(pi: ExtensionAPI) {
	registerExtensionSettings(pi, {
		id: "pi-inturl",
		title: "PI Inturl",
		description: "Internal URL and path shortcut helpers",
		groups: PATH_SHORTCUT_SETTING_GROUPS,
		panels: [createPathShortcutToolPanel()],
		onLoad: (state) => {
			settings = pathShortcutSettingsFromState(state);
		},
		onChange: (change) => {
			settings = pathShortcutSettingsFromState(change.state);
		},
		onClose: (state) => {
			settings = pathShortcutSettingsFromState(state);
		},
	});

	registerPathShortcutExpansion(pi, () => settings ?? DEFAULT_PATH_SHORTCUT_SETTINGS);
}
const TMP_SCHEME = "tmp://";
const ENABLED_TOOLS_GROUP_ID = "pathShortcutsData";
const ENABLED_TOOLS_FIELD_ID = "enabledTools";

export const PATH_SHORTCUT_TOOL_NAMES = ["read", "grep", "find", "ls", "write", "edit"] as const;

export interface PathShortcutSettings {
	enabled: boolean;
	tmpEnabled: boolean;
	enabledTools: readonly string[];
}

export interface PathShortcutOptions {
	tmpRoot?: string;
}

export type PathShortcutExpansionResult =
	| { changed: true; path: string }
	| { changed: false; path: string }
	| { error: string };

export const DEFAULT_PATH_SHORTCUT_SETTINGS: PathShortcutSettings = {
	enabled: true,
	tmpEnabled: true,
	enabledTools: PATH_SHORTCUT_TOOL_NAMES,
};

export const PATH_SHORTCUT_SETTING_GROUPS: SettingGroup[] = [
	{
		id: "pathShortcuts",
		title: "Path shortcuts",
		description: "Expand safe shortcut URIs in tool path inputs",
		display: "plain",
		fields: [
			{
				id: "enabled",
				label: "Path shortcuts",
				defaultValue: DEFAULT_PATH_SHORTCUT_SETTINGS.enabled,
				description: "Enable shortcut URI expansion for tool path inputs",
			},
			{
				id: "tmpEnabled",
				label: "tmp:// paths",
				defaultValue: DEFAULT_PATH_SHORTCUT_SETTINGS.tmpEnabled,
				description: "Expand tmp://name to the system temp directory",
			},
		],
	},
	{
		id: ENABLED_TOOLS_GROUP_ID,
		title: "Path shortcut data",
		display: "hidden",
		fields: [
			{
				id: ENABLED_TOOLS_FIELD_ID,
				label: "Enabled tools",
				defaultValue: serializeToolNames(PATH_SHORTCUT_TOOL_NAMES),
			},
		],
	},
];

export function createPathShortcutToolPanel(): ExtensionSettingsSubpanel {
	return {
		id: "pathShortcutTools",
		label: "└─ Tools",
		description: "Choose built-in tools that expand tmp:// paths",
		currentValue: "open",
		create: createPathShortcutToolPanelComponent,
	};
}

export function pathShortcutSettingsFromState(
	state: SettingsState | undefined,
): PathShortcutSettings {
	const pathShortcuts = state?.pathShortcuts ?? {};
	return {
		enabled: pathShortcuts.enabled !== false,
		tmpEnabled: pathShortcuts.tmpEnabled !== false,
		enabledTools: enabledToolsFromState(state),
	};
}

export function expandPathShortcut(
	path: string,
	settings: PathShortcutSettings = DEFAULT_PATH_SHORTCUT_SETTINGS,
	options: PathShortcutOptions = {},
): PathShortcutExpansionResult {
	if (!settings.enabled) return { changed: false, path };
	if (!path.startsWith(TMP_SCHEME)) return { changed: false, path };
	if (!settings.tmpEnabled) return { changed: false, path };

	const expanded = expandTmpPath(path, options.tmpRoot ?? tmpdir());
	return typeof expanded === "string" ? { changed: true, path: expanded } : expanded;
}

export function applyPathShortcutExpansion(
	event: Pick<ToolCallEvent, "input" | "toolName">,
	settings: PathShortcutSettings = DEFAULT_PATH_SHORTCUT_SETTINGS,
	options: PathShortcutOptions = {},
): ToolCallEventResult | undefined {
	if (!settings.enabledTools.includes(event.toolName)) return undefined;
	const input = event.input as Record<string, unknown>;
	const path = input.path;
	if (typeof path !== "string") return undefined;

	const expanded = expandPathShortcut(path, settings, options);
	if ("error" in expanded) return { block: true, reason: expanded.error };
	if (expanded.changed) input.path = expanded.path;
	return undefined;
}

export function registerPathShortcutExpansion(
	pi: ExtensionAPI,
	getSettings: () => PathShortcutSettings = () => DEFAULT_PATH_SHORTCUT_SETTINGS,
	options: PathShortcutOptions = {},
): void {
	pi.on("tool_call", (event) => applyPathShortcutExpansion(event, getSettings(), options));
}

function createPathShortcutToolPanelComponent(
	options: Parameters<ExtensionSettingsSubpanel["create"]>[0],
) {
	return createGroupedTogglePicker({
		host: options.host,
		theme: options.theme,
		done: options.close,
		helpTitle: "Path shortcut shortcuts",
		panes: [
			{
				id: "tools",
				label: "Tools",
				enabledIds: enabledToolsFromState(options.getState()),
				groups: [
					{
						key: "builtin",
						label: "Built-in tools",
						items: PATH_SHORTCUT_TOOL_NAMES.map((toolName) => ({
							id: toolName,
							label: toolName,
							description: `Expand tmp:// paths in ${toolName} tool calls`,
						})),
					},
				],
			},
		],
		selectionDescription: (selection) => selection.item?.description,
		renderFooter: (selection, width) => {
			const status = selection ? `(${selection.index + 1}/${selection.total})` : "(0/0)";
			return [
				options.theme
					.fg(
						"dim",
						`  ${status} · Space ${selection?.status === "enabled" ? "disable" : "enable"} · Enter collapse/expand · Esc close`,
					)
					.slice(0, width),
			];
		},
		onChange: async (state) => {
			const enabledTools = state.enabledIdsByPane.get("tools") ?? new Set<string>();
			const currentState = options.getState();
			await options.saveState({
				...currentState,
				[ENABLED_TOOLS_GROUP_ID]: {
					...(currentState[ENABLED_TOOLS_GROUP_ID] ?? {}),
					[ENABLED_TOOLS_FIELD_ID]: serializeToolNames(enabledTools),
				},
			});
		},
		onError: options.onError,
	});
}

function enabledToolsFromState(state: SettingsState | undefined): string[] {
	const value = state?.[ENABLED_TOOLS_GROUP_ID]?.[ENABLED_TOOLS_FIELD_ID];
	if (typeof value !== "string") return [...PATH_SHORTCUT_TOOL_NAMES];
	return parseToolNames(value);
}

function parseToolNames(value: string): string[] {
	const allowed = new Set<string>(PATH_SHORTCUT_TOOL_NAMES);
	return [
		...new Set(
			value
				.split(",")
				.map((name) => name.trim())
				.filter((name) => allowed.has(name)),
		),
	];
}

function serializeToolNames(names: Iterable<string>): string {
	const enabled = new Set(names);
	return PATH_SHORTCUT_TOOL_NAMES.filter((name) => enabled.has(name)).join(",");
}

function expandTmpPath(input: string, tmpRoot: string): string | { error: string } {
	let decoded: string;
	try {
		decoded = decodeURIComponent(input.slice(TMP_SCHEME.length));
	} catch {
		return { error: `Invalid tmp:// path encoding: ${input}` };
	}

	if (decoded.includes("\0")) return { error: `Invalid tmp:// path: ${input}` };
	const normalized = decoded.replace(/\\/g, "/");
	if (normalized.startsWith("/"))
		return { error: `Absolute paths are not allowed in tmp:// URLs: ${input}` };

	const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
	if (segments.some((segment) => segment === "..")) {
		return { error: `Path traversal is not allowed in tmp:// URLs: ${input}` };
	}

	const root = resolve(tmpRoot);
	const expanded = segments.length === 0 ? root : resolve(root, ...segments);
	if (expanded !== root && !expanded.startsWith(root + sep)) {
		return { error: `tmp:// path escapes temp root: ${input}` };
	}

	return expanded;
}
