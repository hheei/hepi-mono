import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";

export type OptimizerInfo = (summary: string, details?: unknown, warning?: boolean) => void;
const infoSchema = Type.Object({
	summary: Type.String(),
	details: Type.Optional(Type.Unknown()),
	warning: Type.Optional(Type.Boolean()),
});

/** Native entries render immediately, survive resume, and never enter model context. */
export function createOptimizerInfo(
	pi: Pick<ExtensionAPI, "appendEntry" | "registerEntryRenderer">,
): OptimizerInfo {
	pi.registerEntryRenderer("optimizer-info", (entry, options, theme) => {
		if (!Value.Check(infoSchema, entry.data)) return undefined;
		const { summary, details, warning } = entry.data;
		const heading = `info · optimizer · ${stripVTControlCharacters(summary).replace(/\s+/gu, " ")}`;
		return new Text(
			theme.fg(warning ? "warning" : "dim", heading) +
				(options.expanded && details !== undefined ? `\n${JSON.stringify(details, null, 2)}` : ""),
			1,
			0,
		);
	});
	return (summary, details, warning) =>
		pi.appendEntry("optimizer-info", { summary, details, warning });
}
