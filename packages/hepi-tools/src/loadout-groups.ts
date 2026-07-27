import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type HePiLoadoutGroup,
	registerHePiRuntimeLoadoutGroup,
} from "../../hepi-basics/src/core/index.js";

export type HePiToolExtension = (pi: ExtensionAPI) => void;

export const HEPI_TOOLS_LOADOUT_GROUPS = [
	{
		id: "magic-context",
		label: "Magic Context",
		items: ["ctx_search", "ctx_memory", "ctx_note"],
	},
	{
		id: "web-search",
		label: "Web Search",
		items: ["web_search", "fetch_content", "get_search_content", "source_check"],
	},
	{
		id: "fff",
		label: "FFF",
		items: [
			"find",
			"grep",
			"multi_grep",
			"fffind",
			"ffgrep",
			"fff-multi-grep",
			"find_files",
			"resolve_file",
			"related_files",
			"fff_grep",
			"fff_multi_grep",
		],
	},
] as const satisfies readonly HePiLoadoutGroup[];

export function registerHePiToolsLoadoutGroups(
	pi: ExtensionAPI,
	groups: readonly HePiLoadoutGroup[] = HEPI_TOOLS_LOADOUT_GROUPS,
): void {
	for (const group of groups) registerHePiRuntimeLoadoutGroup(pi, group);
}

/**
 * Keep Loadout ownership with the extension that declares the tools.
 *
 * Pi assigns one source to an aggregate extension entry, so looking at the
 * final sourceInfo cannot distinguish leaf extensions inside hepi-tools.
 * Capturing registerTool calls at the leaf boundary preserves that ownership
 * without duplicating the tool definitions or depending on implementation
 * names in the aggregate package.
 */
export function withHePiToolLoadoutGroup(
	extension: HePiToolExtension,
	group: HePiLoadoutGroup,
): HePiToolExtension {
	return (pi) => {
		const toolNames = new Set<string>();
		const registerTool: ExtensionAPI["registerTool"] = (tool) => {
			pi.registerTool(tool);
			toolNames.add(tool.name);
		};
		const groupedPi: ExtensionAPI = { ...pi, registerTool };
		extension(groupedPi);
		const items = toolNames.size > 0 ? [...toolNames] : group.items;
		registerHePiRuntimeLoadoutGroup(pi, items === undefined ? group : { ...group, items });
	};
}
