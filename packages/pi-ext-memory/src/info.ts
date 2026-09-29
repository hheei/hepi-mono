import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isRecord } from "@hheei/pi-ext-core";

/** One recalled knowledge page, as the recall injected it into the prompt. */
export interface MemoryInfoPage {
	readonly pageId: string;
	readonly page: string;
	readonly snippet: string;
}

/** What an injection entry records: the recalled pages and whether the container was cut. */
export interface MemoryInfoDetails {
	readonly pages: readonly MemoryInfoPage[];
	readonly truncated: boolean;
}

export type MemoryInfo = (summary: string, details?: MemoryInfoDetails) => void;

const TRUNCATION_ROW = "the injected memory was cut to its character budget";

/**
 * Recalled memory is remote data, so it is reduced to what a terminal can render safely:
 * control sequences would otherwise corrupt the row and its measured width.
 */
function displayText(text: string): string {
	return stripVTControlCharacters(text).replaceAll("\r", "");
}

function pageOf(value: unknown): MemoryInfoPage | undefined {
	if (!isRecord(value)) return undefined;
	const { pageId, page, snippet } = value;
	if (typeof pageId !== "string" || typeof page !== "string" || typeof snippet !== "string")
		return undefined;
	return { pageId, page, snippet };
}

/**
 * Rows for one injection entry, so the recalled pages are readable without the raw payload.
 *
 * Collapsed shows the page titles that were retrieved; expanded adds each page id and the
 * snippet the recall put in front of the model. Entries written before this payload existed
 * carry a plain id/title list and keep rendering as a payload dump.
 *
 * The rows speak the same vocabulary as the tools: 󰄴 for content that did make it into the
 * prompt, 󰀪 for a container that had to be cut.
 */
export function renderMemoryInfo(
	data: unknown,
	expanded: boolean,
	theme: Theme,
): string | undefined {
	if (!isRecord(data) || typeof data.summary !== "string") return undefined;
	const heading = theme.fg("dim", `info · memory · ${displayText(data.summary)}`);
	const details = data.details;
	if (!isRecord(details)) {
		return Array.isArray(details) && expanded
			? `${heading}\n${JSON.stringify(details, null, 2)}`
			: heading;
	}
	const rows = [heading];
	for (const page of (Array.isArray(details.pages) ? details.pages : []).map(pageOf)) {
		if (page === undefined) continue;
		rows.push(`  ${theme.fg("success", "󰄴")} ${theme.fg("text", displayText(page.page))}`);
		if (!expanded) continue;
		rows.push(`    ${theme.fg("dim", page.pageId)}`);
		const snippet = displayText(page.snippet).trim();
		// One row per recalled line, so a markdown excerpt keeps its structure instead of
		// collapsing into a single unwrapped block.
		for (const line of snippet.split("\n")) rows.push(`    ${theme.fg("muted", line)}`);
	}
	if (details.truncated === true) rows.push(`  ${theme.fg("warning", `󰀪 ${TRUNCATION_ROW}`)}`);
	return rows.join("\n");
}

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
		const text = renderMemoryInfo(entry.data, options.expanded, theme);
		return text === undefined ? undefined : new Text(text, 1, 0);
	});
	return (summary, details) => {
		pi.appendEntry("memory-info", { summary, details });
	};
}
