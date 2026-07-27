import { createSelectorPanelLayout, SELECTOR_PANEL_MIN_WIDTH } from "../selector-panel-layout.js";

export type SettingsLayoutMode = "wide" | "narrow";

export interface SettingsLayout {
	readonly width: number;
	readonly mode: SettingsLayoutMode;
	readonly leftWidth: number;
	readonly listContentWidth: number;
	readonly scrollbarGap: number;
	readonly scrollbarWidth: number;
	readonly gap: number;
	readonly descriptionWidth: number;
	readonly descriptionHeight: number;
	readonly listHeight: number;
	readonly itemCapacity: number;
	readonly indicatorWidth: number;
	readonly keyWidth: number;
	readonly valueGap: number;
	readonly valueWidth: number;
	readonly valueStart: number;
}

const SETTINGS_WIDE_KEY_MAX_WIDTH = 30;
export const SETTINGS_WIDE_MIN_WIDTH = SELECTOR_PANEL_MIN_WIDTH;

export function createSettingsLayout(rawWidth: number, rawHeight?: number): SettingsLayout {
	const width = Math.max(0, Math.floor(rawWidth));
	const split = createSelectorPanelLayout(width, rawHeight, 10);
	const mode: SettingsLayoutMode = split.mode === "split" ? "wide" : "narrow";
	const gap = split.gap;
	const descriptionWidth = split.rightWidth;
	const leftWidth = split.leftWidth;
	const scrollbarGap = 2;
	const scrollbarWidth = 1;
	const listContentWidth = Math.max(0, leftWidth - scrollbarGap - scrollbarWidth);
	const indicatorWidth = Math.min(2, listContentWidth);
	const valueGap = listContentWidth - indicatorWidth > 0 ? 1 : 0;
	const availableAfterIndicator = Math.max(0, listContentWidth - indicatorWidth - valueGap);
	const preferredValueWidth =
		mode === "wide" ? Math.min(24, Math.max(20, Math.floor(availableAfterIndicator / 2))) : 18;
	const wideKeyWidth = Math.min(
		SETTINGS_WIDE_KEY_MAX_WIDTH,
		Math.max(0, availableAfterIndicator - preferredValueWidth),
	);
	const valueWidth =
		mode === "wide"
			? availableAfterIndicator - wideKeyWidth
			: Math.min(preferredValueWidth, Math.max(0, Math.floor(availableAfterIndicator / 2)));
	const keyWidth =
		mode === "wide" ? wideKeyWidth : Math.max(0, availableAfterIndicator - valueWidth);
	const panelHeight = split.panelHeight;
	const listHeight = mode === "wide" ? Math.max(3, panelHeight - 1) : Math.max(8, panelHeight);

	return {
		width,
		mode,
		leftWidth,
		listContentWidth,
		scrollbarGap,
		scrollbarWidth,
		gap,
		descriptionWidth,
		descriptionHeight: panelHeight,
		listHeight,
		itemCapacity: Math.max(1, listHeight - 2),
		indicatorWidth,
		keyWidth,
		valueGap,
		valueWidth,
		valueStart: indicatorWidth + keyWidth + valueGap,
	};
}
