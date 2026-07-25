import type { Theme } from "@earendil-works/pi-coding-agent";
import { padToWidth, truncateToWidth, visibleWidth } from "../../ui/text.js";
import {
	DEFAULT_STATUSBAR_FORMAT_TOKENS,
	joinStatusbarFormat,
	type RenderedStatusbarFormat,
	renderStatusbarFormat,
} from "./format.js";
import { type StatusbarSnapshot, thinkingGlyph } from "./model.js";

function renderWithFill(
	beforeFill: string,
	afterFill: string,
	width: number,
	rail: (text: string) => string,
): string {
	const bridgeBudget = width - visibleWidth(`${beforeFill}${afterFill}`);
	const bridge =
		bridgeBudget === 0
			? ""
			: bridgeBudget === 1
				? rail("─")
				: ` ${rail("─".repeat(bridgeBudget - 1))}`;
	return `${beforeFill}${bridge}${afterFill}`;
}

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
	const tokensRole = snapshot.contextTokens === "?" ? "muted" : levelRole;
	const advisorRole =
		snapshot.advisorIndicator === "blocker"
			? "error"
			: snapshot.advisorIndicator === "concern"
				? "warning"
				: "accent";
	const advisorIndicator = snapshot.advisorIndicator === undefined ? "" : style(advisorRole, "✦");
	const model = `${style("text", snapshot.model)}${advisorIndicator ? ` ${advisorIndicator}` : ""}`;
	const prefix = `${rail("─")} ${style("accent", "π")} ${sep("·")} `;
	const thinking = style("muted", thinkingGlyph(snapshot.thinkingLevel));
	const context = ` ${sep("·")} ${style(meterRole, snapshot.meter)} ${style(tokensRole, `${snapshot.contextTokens}/${snapshot.contextLimit}`)}`;
	let keptStatuses = snapshot.statuses;
	const title = snapshot.sessionName;
	const formatted = (): RenderedStatusbarFormat =>
		renderStatusbarFormat(DEFAULT_STATUSBAR_FORMAT_TOKENS, {
			prefix,
			thinking,
			model,
			context,
			statuses: keptStatuses.length ? ` ${sep("·")} ${keptStatuses.join(` ${sep("·")} `)}` : "",
			title: title ? ` ${style("muted", title)} ${rail("─")}` : rail("─"),
		});
	let output = formatted();
	let beforeFill = joinStatusbarFormat(output.beforeFill);
	let afterFill = joinStatusbarFormat(output.afterFill);
	let mandatory = visibleWidth(`${beforeFill}${afterFill}`);
	while (keptStatuses.length && mandatory > target) {
		keptStatuses = keptStatuses.slice(0, -1);
		output = formatted();
		beforeFill = joinStatusbarFormat(output.beforeFill);
		afterFill = joinStatusbarFormat(output.afterFill);
		mandatory = visibleWidth(`${beforeFill}${afterFill}`);
	}
	if (mandatory > target) {
		const modelIndex = output.beforeFill.findIndex(
			(part) => part.type === "variable" && part.name === "model",
		);
		if (modelIndex < 0) return truncateToWidth(`${beforeFill}${afterFill}`, target);
		const fixedBeforeModel = joinStatusbarFormat(output.beforeFill.slice(0, modelIndex));
		const suffix = `${joinStatusbarFormat(output.beforeFill.slice(modelIndex + 1))}${afterFill}`;
		const room = target - visibleWidth(fixedBeforeModel) - visibleWidth(suffix);
		if (room > 0) {
			if (!advisorIndicator)
				return `${fixedBeforeModel}${truncateToWidth(snapshot.model, room)}${suffix}`;
			if (room === 1) return `${fixedBeforeModel}${advisorIndicator}${suffix}`;
			return `${fixedBeforeModel}${truncateToWidth(snapshot.model, room - 2)} ${advisorIndicator}${suffix}`;
		}
		if (advisorIndicator)
			return renderWithFill(
				`${truncateToWidth(fixedBeforeModel, Math.max(0, target - 1))}${advisorIndicator}`,
				"",
				target,
				rail,
			);
		return truncateToWidth(`${fixedBeforeModel}${snapshot.model}${suffix}`, target);
	}
	return renderWithFill(beforeFill, afterFill, target, rail);
}

export function renderExtensionStatusFooter(
	width: number,
	statuses: readonly string[],
	theme: Theme,
): string[] {
	const target = Math.max(0, Math.floor(width));
	if (!target || statuses.length === 0) return [];
	const separator = theme.fg("dim", " · ");
	const line = truncateToWidth(statuses.join(separator), target);
	return [padToWidth(line, target)];
}

export function renderStatusbar(
	width: number,
	snapshot: StatusbarSnapshot,
	theme: Theme,
): string[] {
	return width <= 0 ? [] : [padToWidth(renderStatusbarLine(width, snapshot, theme), width)];
}
