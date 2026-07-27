import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type HePiLoadoutGroup,
	registerHePiRuntimeLoadoutGroup,
} from "../../hepi-basics/src/core/index.js";

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
			"tool:local:find",
			"tool:local:grep",
			"tool:local:multi_grep",
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

export function registerHePiToolsLoadoutGroups(pi: ExtensionAPI): void {
	for (const group of HEPI_TOOLS_LOADOUT_GROUPS) registerHePiRuntimeLoadoutGroup(pi, group);
}
