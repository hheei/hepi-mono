import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { ADVISORY_MESSAGE_TYPE, type AdvisorAdvice } from "./model.js";
export function registerAdvisorRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<{ notes: readonly AdvisorAdvice[] }>(
		ADVISORY_MESSAGE_TYPE,
		(message, _options, theme) => {
			const notes = message.details?.notes;
			if (!notes || notes.length === 0) return undefined;
			const container = new Container();
			for (const note of notes) {
				const color =
					note.severity === "blocker" ? "error" : note.severity === "concern" ? "warning" : "dim";
				container.addChild(
					new Text(
						`${theme.fg(color, `[advisor ${note.severity}]`)} ${theme.fg("muted", note.note)}`,
						1,
						0,
					),
				);
			}
			return container;
		},
	);
}
