import type {
	CustomEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { sessionLog } from "#core/shared/logger";

export const CTX_STATUS_CUSTOM_TYPE = "ctx-status";

export type CtxStatusLevel = "info" | "success" | "warning" | "error";

export interface CtxStatusEntryData {
	title: string;
	text: string;
	level?: CtxStatusLevel | undefined;
	details?: unknown | undefined;
}

export type CtxStatusMessageContent = CtxStatusEntryData;

type CtxStatusEntryRenderer = (
	entry: CustomEntry<CtxStatusEntryData>,
	options: { expanded: boolean },
	theme: Theme,
) => Component | undefined;

export type PiMessageSender = Pick<ExtensionAPI, "appendEntry" | "registerEntryRenderer">;

export function resolveSessionId(ctx: ExtensionCommandContext): string | undefined {
	const id = ctx.sessionManager.getSessionId();
	return id.length > 0 ? id : undefined;
}

function statusTitleColor(level: CtxStatusLevel | undefined) {
	switch (level) {
		case "success":
			return "success" as const;
		case "warning":
			return "warning" as const;
		case "error":
			return "error" as const;
		default:
			return "accent" as const;
	}
}

export const renderCtxStatusEntry: CtxStatusEntryRenderer = (entry, _options, theme) => {
	const data = entry?.data;
	if (
		!data ||
		typeof data !== "object" ||
		typeof data.title !== "string" ||
		typeof data.text !== "string"
	) {
		return undefined;
	}

	const title = theme.bold(theme.fg(statusTitleColor(data.level), `[${data.title}]`));
	const body = theme.fg("customMessageText", data.text);
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(`${title}\n${body}`));
	return box;
};

/** Register the model-invisible status-entry renderer. */
export function registerCtxStatusEntryRenderer(pi: PiMessageSender): boolean {
	pi.registerEntryRenderer<CtxStatusEntryData>(CTX_STATUS_CUSTOM_TYPE, renderCtxStatusEntry);
	return true;
}

export function sendCtxStatusMessage(
	pi: PiMessageSender,
	content: CtxStatusMessageContent,
	details?: unknown,
): void {
	const data: CtxStatusEntryData = {
		...content,
		details: details ?? content.details,
	};
	pi.appendEntry<CtxStatusEntryData>(CTX_STATUS_CUSTOM_TYPE, data);
	sessionLog("pi-status", `${content.title}: ${content.text}`);
}
