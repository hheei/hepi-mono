import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

const TEMPORAL_MARKER_PATTERN = /^<!-- \+\d+(?:h(?: \d+m)?|m) -->\n/;
const TEMPORAL_AWARENESS_THRESHOLD_MS = 5 * 60 * 1_000;
const HISTORY_TAG_PATTERN = /^(§\d+§ )/;

function markerForGap(gapMs: number): string | undefined {
	if (gapMs <= TEMPORAL_AWARENESS_THRESHOLD_MS) return undefined;
	const minutes = Math.floor(gapMs / 60_000);
	if (minutes < 60) return `<!-- +${minutes}m -->\n`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `<!-- +${hours}h${remainingMinutes === 0 ? "" : ` ${remainingMinutes}m`} -->\n`;
}

function prependMarker(text: string, marker: string): string {
	const tag = text.match(HISTORY_TAG_PATTERN)?.[0] ?? "";
	const body = text.slice(tag.length);
	return TEMPORAL_MARKER_PATTERN.test(body) ? text : `${tag}${marker}${body}`;
}

/** Adds upstream-compatible temporal markers to model-only user-message projections. */
export function injectMctxTemporalMarkers(
	messages: readonly AgentMessage[],
): readonly AgentMessage[] {
	let previousTimestamp: number | undefined;
	let changed = false;
	const result = messages.map((message) => {
		const marker =
			message.role === "user" &&
			previousTimestamp !== undefined &&
			typeof message.timestamp === "number"
				? markerForGap(message.timestamp - previousTimestamp)
				: undefined;
		if (typeof message.timestamp === "number") previousTimestamp = message.timestamp;
		if (marker === undefined || message.role !== "user") return message;
		if (typeof message.content === "string") {
			const content = prependMarker(message.content, marker);
			if (content === message.content) return message;
			changed = true;
			return { ...message, content };
		}
		const index = message.content.findIndex((part) => part.type === "text");
		if (index < 0) return message;
		const part = message.content[index] as TextContent | ImageContent;
		if (part.type !== "text") return message;
		const text = prependMarker(part.text, marker);
		if (text === part.text) return message;
		changed = true;
		return {
			...message,
			content: message.content.map((value, partIndex) =>
				partIndex === index && value.type === "text" ? { ...value, text } : value,
			),
		};
	});
	return changed ? result : messages;
}
