import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { ADVISORY_MESSAGE_TYPE, type AdvisorAdvice } from "./model.js";

export function createAdvisorMessageComponent(
	notes: readonly AdvisorAdvice[],
	theme: Theme,
): Component {
	return {
		invalidate(): void {},
		render(width: number): string[] {
			if (width <= 0) return [];
			const padding = width >= 3 ? 1 : 0;
			const innerWidth = Math.max(1, width - padding * 2);
			return notes.flatMap((note) => {
				const prefixRole =
					note.severity === "blocker" ? "error" : note.severity === "concern" ? "warning" : "dim";
				return new Text(`✦ ${note.note}`, 0, 0).render(innerWidth).map((line, index) => {
					const content =
						index === 0
							? `${theme.fg(prefixRole, line.slice(0, 1))}${theme.fg("dim", line.slice(1))}`
							: theme.fg("dim", line);
					const padded = `${" ".repeat(padding)}${content}${" ".repeat(padding)}`;
					return theme.bg("customMessageBg", padded);
				});
			});
		},
	};
}

export function registerAdvisorRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<{ notes: readonly AdvisorAdvice[] }>(
		ADVISORY_MESSAGE_TYPE,
		(message, _options, theme) => {
			const notes = message.details?.notes;
			return notes && notes.length > 0 ? createAdvisorMessageComponent(notes, theme) : undefined;
		},
	);
}
