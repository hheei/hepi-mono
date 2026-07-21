import type { HePiMaybePromise } from "./modules.js";

export interface HePiPanel {
	readonly id: string;
	readonly label?: string;
	render(width: number): readonly string[];
	handleInput?(input: string): HePiMaybePromise<boolean | undefined>;
	invalidate?(): void;
}

export type HePiSettingsSubpanel = HePiPanel;

export function createHePiPanel(panel: HePiPanel): HePiPanel {
	return panel;
}
