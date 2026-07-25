import { createSplitLayout } from "../layout.js";

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
const SETTINGS_WIDE_GAP = 3;
const SETTINGS_WIDE_MIN_LEFT_WIDTH = 24;
const SETTINGS_WIDE_MAX_LEFT_WIDTH = 46;
const SETTINGS_WIDE_MIN_DESCRIPTION_WIDTH = 32;
const SETTINGS_WIDE_MAX_DESCRIPTION_WIDTH = 100;
export const SETTINGS_WIDE_MIN_WIDTH = 75;

export function createSettingsLayout(rawWidth: number, rawHeight?: number): SettingsLayout {
	const width = Math.max(0, Math.floor(rawWidth));
	const split = createSplitLayout({
		width,
		breakpoint: SETTINGS_WIDE_MIN_WIDTH,
		gap: SETTINGS_WIDE_GAP,
		leftMin: SETTINGS_WIDE_MIN_LEFT_WIDTH,
		leftMax: SETTINGS_WIDE_MAX_LEFT_WIDTH,
		rightMin: SETTINGS_WIDE_MIN_DESCRIPTION_WIDTH,
		rightMax: SETTINGS_WIDE_MAX_DESCRIPTION_WIDTH,
	});
	const mode: SettingsLayoutMode = split.mode === "split" ? "wide" : "narrow";
	const gap = split.gap;
	const descriptionWidth = split.rightWidth;
	const leftWidth = split.leftWidth;
	const scrollbarGap = 2;
	const scrollbarWidth = 1;
	const listContentWidth = Math.max(0, leftWidth - scrollbarGap - scrollbarWidth);
	const indicatorWidth = Math.min(2, listContentWidth);
	const valueGap = listContentWidth - indicatorWidth > 0 ? 1 : 0;
	const preferredValueWidth = mode === "wide" ? 16 : 18;
	const availableAfterIndicator = Math.max(0, listContentWidth - indicatorWidth - valueGap);
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
	const panelHeight =
		rawHeight === undefined ? 9 : Math.max(4, Math.floor(Math.max(0, rawHeight) * 0.3));
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
