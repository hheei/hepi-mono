import type { Theme } from "@earendil-works/pi-coding-agent";
import { padToWidth, truncateToWidth, visibleWidth } from "./text.js";

export interface TabBarOptions {
	readonly labels: readonly string[];
	readonly activeIndex: number;
	readonly width: number;
	readonly theme: Theme;
}

export function renderTabs(
	labels: readonly string[],
	activeIndex: number,
	width: number,
	theme: Theme,
): string[] {
	if (width <= 0) return ["", "", ""];
	const available = Math.max(0, width - 1);
	const maxTabWidth = Math.max(4, Math.floor(available / Math.max(1, labels.length)));
	const tabs = labels.map((rawLabel, index) => {
		const label = truncateToWidth(rawLabel, Math.max(0, maxTabWidth - 4));
		const innerWidth = Math.max(2, visibleWidth(label) + 2);
		const content = ` ${padToWidth(label, innerWidth - 2)} `;
		const active = index === activeIndex;
		const style = (text: string): string => theme.fg(active ? "accent" : "text", text);
		return {
			top: style(`╭${"─".repeat(innerWidth)}╮`),
			middle: style(`│${active ? theme.bold(content) : content}│`),
			bottom: style(active ? `╯${" ".repeat(innerWidth)}╰` : `┴${"─".repeat(innerWidth)}┴`),
		};
	});
	const top = ` ${tabs.map((tab) => tab.top).join("")}`;
	const middle = ` ${tabs.map((tab) => tab.middle).join("")}`;
	const bottomPrefix = `─${tabs.map((tab) => tab.bottom).join("")}`;
	const bottom = `${bottomPrefix}${"─".repeat(Math.max(0, width - visibleWidth(bottomPrefix)))}`;
	return [top, middle, bottom].map((line) => truncateToWidth(line, width, ""));
}

export function renderTabBar(options: TabBarOptions): string[];
export function renderTabBar(
	labels: readonly string[],
	activeIndex: number,
	width: number,
	theme: Theme,
): string[];
export function renderTabBar(
	optionsOrLabels: TabBarOptions | readonly string[],
	activeIndex?: number,
	width?: number,
	theme?: Theme,
): string[] {
	if (Array.isArray(optionsOrLabels))
		return renderTabs(optionsOrLabels, activeIndex ?? 0, width ?? 0, theme!);
	const options = optionsOrLabels as TabBarOptions;
	return renderTabs(options.labels, options.activeIndex, options.width, options.theme);
}
