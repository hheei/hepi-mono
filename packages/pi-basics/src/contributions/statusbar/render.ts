import type { Theme } from "@earendil-works/pi-coding-agent";
import { padToWidth, truncateToWidth, visibleWidth } from "../../ui/text.js";
import { type StatusbarSnapshot, thinkingGlyph } from "./model.js";

export function renderStatusbarLine(
	width: number,
	snapshot: StatusbarSnapshot,
	theme: Theme,
): string {
	const target = Math.max(0, Math.floor(width));
	if (!target) return "";
	const style = (role: Parameters<Theme["fg"]>[0], text: string) => theme.fg(role, text);
	const rail = (text: string) => style("border", text);
	const sep = (text: string) => style("muted", text);
	const levelRole =
		snapshot.percent === null
			? "text"
			: snapshot.percent >= 90
				? "error"
				: snapshot.percent >= 70
					? "warning"
					: "success";
	const meterRole = snapshot.meter === "??" ? "dim" : levelRole;
	const limitRole = snapshot.contextLimit === "?" ? "dim" : levelRole;
	const prefix = `${rail("─")} ${style("accent", "π")} ${sep("·")} `;
	const thinking = style("muted", thinkingGlyph(snapshot.thinkingLevel));
	const context = ` ${sep("·")} ${sep("◫")} `;
	const meter = style(meterRole, snapshot.meter);
	const limit = style(limitRole, snapshot.contextLimit);
	const statuses = snapshot.statuses;
	let keptStatuses = statuses;
	let title = snapshot.sessionName;
	const titleTail = () => (title ? ` ${style("muted", title)} ${rail("─")}` : rail("─"));
	const statusPart = () =>
		keptStatuses.length ? ` ${sep("·")} ${keptStatuses.join(` ${sep("·")} `)}` : "";
	const fixed = () =>
		`${prefix}${thinking} ${style("text", snapshot.model)}${context}${meter} ${limit}`;
	while (title && visibleWidth(`${fixed()}${statusPart()}${titleTail()}`) > target)
		title = undefined;
	while (keptStatuses.length && visibleWidth(`${fixed()}${statusPart()}${titleTail()}`) > target)
		keptStatuses = keptStatuses.slice(0, -1);
	const mandatory = visibleWidth(`${fixed()}${statusPart()}${titleTail()}`);
	if (mandatory > target) {
		const fixedBeforeModel = `${prefix}${thinking} `;
		const suffix = `${context}${meter} ${limit}${statusPart()}${titleTail()}`;
		const room = target - visibleWidth(fixedBeforeModel) - visibleWidth(suffix);
		if (room > 0) return `${fixedBeforeModel}${truncateToWidth(snapshot.model, room)}${suffix}`;
		return truncateToWidth(`${fixedBeforeModel}${snapshot.model}${suffix}`, target);
	}
	const bridgeBudget = target - mandatory;
	const bridge =
		bridgeBudget === 0
			? ""
			: bridgeBudget === 1
				? rail("─")
				: ` ${rail("─".repeat(bridgeBudget - 1))}`;
	return `${fixed()}${statusPart()}${bridge}${titleTail()}`;
}

export function renderStatusbar(
	width: number,
	snapshot: StatusbarSnapshot,
	theme: Theme,
): string[] {
	return width <= 0 ? [] : [padToWidth(renderStatusbarLine(width, snapshot, theme), width)];
}
