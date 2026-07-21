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

const SETTINGS_WIDE_KEY_MAX_WIDTH = 24;
const SETTINGS_WIDE_GAP = 3;
const SETTINGS_WIDE_MIN_LEFT_WIDTH = 24;
const SETTINGS_WIDE_MAX_LEFT_WIDTH = 40;
const SETTINGS_WIDE_MIN_DESCRIPTION_WIDTH = 32;
const SETTINGS_WIDE_MAX_DESCRIPTION_WIDTH = 44;
export const SETTINGS_WIDE_MIN_WIDTH = 72;

export function createSettingsLayout(rawWidth: number): SettingsLayout {
	const width = Math.max(0, Math.floor(rawWidth));
	const mode: SettingsLayoutMode = width >= SETTINGS_WIDE_MIN_WIDTH ? "wide" : "narrow";
	const gap = mode === "wide" ? SETTINGS_WIDE_GAP : 0;
	const requestedDescriptionWidth = Math.min(
		SETTINGS_WIDE_MAX_DESCRIPTION_WIDTH,
		Math.max(SETTINGS_WIDE_MIN_DESCRIPTION_WIDTH, Math.floor(width * 0.38)),
	);
	const descriptionWidth =
		mode === "wide"
			? Math.min(requestedDescriptionWidth, Math.max(0, width - gap - SETTINGS_WIDE_MIN_LEFT_WIDTH))
			: 0;
	const leftWidth =
		mode === "wide"
			? Math.min(SETTINGS_WIDE_MAX_LEFT_WIDTH, Math.max(0, width - gap - descriptionWidth))
			: width;
	const scrollbarGap = 2;
	const scrollbarWidth = 1;
	const listContentWidth = Math.max(0, leftWidth - scrollbarGap - scrollbarWidth);
	const indicatorWidth = Math.min(2, listContentWidth);
	const valueGap = listContentWidth - indicatorWidth > 0 ? 1 : 0;
	const preferredValueWidth = mode === "wide" ? 13 : 16;
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
	const listHeight = mode === "wide" ? 7 : 8;

	return {
		width,
		mode,
		leftWidth,
		listContentWidth,
		scrollbarGap,
		scrollbarWidth,
		gap,
		descriptionWidth,
		descriptionHeight: 9,
		listHeight,
		itemCapacity: Math.max(1, listHeight - 1),
		indicatorWidth,
		keyWidth,
		valueGap,
		valueWidth,
		valueStart: indicatorWidth + keyWidth + valueGap,
	};
}

export const layoutSettings = createSettingsLayout;
