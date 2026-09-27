import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isRecord } from "@hheei/pi-ext-core";

export type MemoryInfo = (summary: string, details?: unknown) => void;

/**
 * Reports what the memory injected into the prompt.
 *
 * Native entries render in the transcript as they happen, survive resume, and never enter the
 * model's context, so injected memory stays inspectable without being paid for again.
 */
export function createMemoryInfo(
	pi: Pick<ExtensionAPI, "appendEntry" | "registerEntryRenderer">,
): MemoryInfo {
	pi.registerEntryRenderer("memory-info", (entry, options, theme) => {
		const data = entry.data;
		if (!isRecord(data) || typeof data.summary !== "string") return undefined;
		const heading = `info · memory · ${data.summary}`;
		const body =
			options.expanded && data.details !== undefined
				? `\n${JSON.stringify(data.details, null, 2)}`
				: "";
		return new Text(theme.fg("dim", heading) + body, 1, 0);
	});
	return (summary, details) => {
		pi.appendEntry("memory-info", { summary, details });
	};
}
