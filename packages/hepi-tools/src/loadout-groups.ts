import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type HepiLoadoutGroup,
	registerHepiRuntimeLoadoutGroup,
} from "../../hepi-basics/src/core/index.js";

export type HepiToolExtension = (pi: ExtensionAPI) => void;

export const HEPI_TOOLS_LOADOUT_GROUPS = [
	{
		id: "magic-context",
		label: "Magic Context",
		items: ["ctx_search", "ctx_expand", "ctx_memory", "ctx_note", "ctx_reduce", "todowrite"],
	},
	{
		id: "web-search",
		label: "Web Search",
		items: ["web_search", "fetch_content", "get_search_content", "source_check"],
	},
	{
		id: "fff",
		label: "FFF",
		items: ["find", "grep", "read", "find_files", "fff_multi_grep"],
	},
] as const satisfies readonly HepiLoadoutGroup[];

export function registerHepiToolsLoadoutGroups(
	pi: ExtensionAPI,
	groups: readonly HepiLoadoutGroup[] = HEPI_TOOLS_LOADOUT_GROUPS,
): void {
	for (const group of groups) registerHepiRuntimeLoadoutGroup(pi, group);
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
export function withHepiToolLoadoutGroup(
	extension: HepiToolExtension,
	group: HepiLoadoutGroup,
	additionalItems: readonly string[] = [],
): HepiToolExtension {
	return (pi) => {
		const toolNames = new Set<string>();
		const registerTool: ExtensionAPI["registerTool"] = (tool) => {
			pi.registerTool(tool);
			toolNames.add(tool.name);
		};
		const groupedPi: ExtensionAPI = { ...pi, registerTool };
		extension(groupedPi);
		const items =
			toolNames.size > 0 ? [...new Set([...additionalItems, ...toolNames])] : group.items;
		registerHepiRuntimeLoadoutGroup(pi, items === undefined ? group : { ...group, items });
	};
}
