import { createLsToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolTui, registerManagedLoadoutTool, type ToolTui } from "@hheei/pi-ext-core";

const OWNER = "@hheei/pi-ext-tools";

/** Register Pi 0.87's native directory listing without reimplementing its semantics. */
export function registerLsTool(pi: ExtensionAPI, tui: ToolTui = createToolTui()) {
	const tool = createLsToolDefinition(process.cwd());
	registerManagedLoadoutTool(
		pi,
		{
			id: "ls",
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tui.frame(tool, { maxBodyLines: Number.POSITIVE_INFINITY }),
	);
	return tool;
}
