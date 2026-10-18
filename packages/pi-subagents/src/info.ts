import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readMessageView } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { VISUAL_SUBAGENT_GLYPH, VISUAL_SUBAGENT_TONE } from "./domain.js";
import type { ParentChannelReport } from "./manager.js";
import { formatSubagentId } from "./status.js";

export const SUBAGENT_INFO_TYPE = "subagent-info";
const infoSchema = Type.Object({
	id: Type.String(),
	agent: Type.String(),
	status: Type.Union([
		Type.Literal("running"),
		Type.Literal("done"),
		Type.Literal("blocked"),
		Type.Literal("error"),
	]),
	message: Type.String(),
});

/** Keep line breaks, expand tabs, and remove terminal control characters from child text. */
export function displaySubagentText(text: string): string {
	return stripVTControlCharacters(text)
		.replaceAll("\t", "    ")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}

interface ShownSubagent {
	readonly id: string;
	readonly agent: string;
	readonly status: "running" | "done" | "blocked" | "error";
	readonly message: string;
}

function shownSubagent(data: unknown): ShownSubagent | undefined {
	if (!Value.Check(infoSchema, data)) return undefined;
	return {
		id: formatSubagentId(displaySubagentText(data.id).replace(/\s+/gu, " ")),
		agent: displaySubagentText(data.agent).replace(/\s+/gu, " "),
		status: data.status,
		message: displaySubagentText(data.message),
	};
}

export function renderSubagentInfo(
	data: unknown,
	expanded: boolean,
	theme: Pick<Theme, "fg">,
): string | undefined {
	const shown = shownSubagent(data);
	if (shown === undefined) return undefined;
	const heading =
		theme.fg("dim", "info · agents · ") +
		theme.fg(VISUAL_SUBAGENT_TONE[shown.status], VISUAL_SUBAGENT_GLYPH[shown.status]) +
		theme.fg("dim", ` ${shown.id} ${shown.agent} · ${shown.status}`);
	return expanded ? `${heading}\n${shown.message}` : heading;
}

/** Native transcript entries survive resume and never enter the model context. */
export function registerSubagentInfo(pi: Pick<ExtensionAPI, "registerEntryRenderer">): void {
	pi.registerEntryRenderer(SUBAGENT_INFO_TYPE, (entry, options, theme) => {
		const create = readMessageView(pi);
		const shown = create === undefined ? undefined : shownSubagent(entry.data);
		if (create !== undefined && shown !== undefined) {
			const message = shown.message.trim();
			return create({
				theme,
				header: {
					kind: "agents",
					summary: `${VISUAL_SUBAGENT_GLYPH[shown.status]} ${shown.id} ${shown.agent} · ${shown.status}`,
					tone: VISUAL_SUBAGENT_TONE[shown.status],
				},
				...(message === "" ? {} : { body: shown.message }),
				stateHolder: entry,
				forcedExpanded: options.expanded,
			});
		}
		const text = renderSubagentInfo(entry.data, options.expanded, theme);
		return text === undefined ? undefined : new Text(text, 1, 0);
	});
}

export function appendSubagentInfo(
	pi: Pick<ExtensionAPI, "appendEntry">,
	report: ParentChannelReport,
): void {
	const status =
		report.reason === "success"
			? "done"
			: report.reason === "blocked" || report.reason === "error"
				? report.reason
				: report.status;
	pi.appendEntry(SUBAGENT_INFO_TYPE, {
		id: report.childId,
		agent: report.agent,
		status,
		message: report.message,
	});
}
