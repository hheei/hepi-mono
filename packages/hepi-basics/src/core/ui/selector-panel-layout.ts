import { createSplitLayout, type SplitLayout } from "./layout.js";

export const SELECTOR_PANEL_MIN_WIDTH = 75;

export interface SelectorPanelLayout extends SplitLayout {
	readonly panelHeight: number;
}

/** Shared outer geometry for selector lists with an optional detail panel. */
export function createSelectorPanelLayout(
	rawWidth: number,
	rawHeight: number | undefined,
	fallbackPanelHeight: number,
): SelectorPanelLayout {
	const split = createSplitLayout({
		width: rawWidth,
		breakpoint: SELECTOR_PANEL_MIN_WIDTH,
		gap: 3,
		leftMin: 24,
		leftMax: 54,
		rightMin: 32,
		rightMax: 100,
	});
	const panelHeight =
		rawHeight === undefined
			? Math.max(4, Math.floor(fallbackPanelHeight))
			: Math.max(4, Math.floor(Math.max(0, rawHeight) * 0.3) + 1);
	return { ...split, panelHeight };
}
