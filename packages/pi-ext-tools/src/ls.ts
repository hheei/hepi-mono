import { createLsToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolTui, registerManagedTool, type ToolTui } from "@hheei/pi-ext-core";

const OWNER = "@hheei/pi-ext-tools";

/** Register Pi 0.87's native directory listing without reimplementing its semantics. */
export function registerLsTool(pi: ExtensionAPI, tui: ToolTui = createToolTui()) {
	const tool = createLsToolDefinition(process.cwd());
	registerManagedTool(
		pi,
		{
			id: "ls",
			owner: OWNER,
		},
		tui.frame(tool, { maxBodyLines: Number.POSITIVE_INFINITY }),
	);
	return tool;
}
