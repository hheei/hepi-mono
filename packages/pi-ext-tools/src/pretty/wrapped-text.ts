import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * Renders one block of tool input verbatim for a frame's request body. Rows wrap instead of
 * truncating (the input has to stay complete to be worth showing), each row is painted through
 * the frame theme so `text` keeps the terminal default on the current Trace and dims on a later
 * one, and rows are cached per width because Pi re-renders every component on every frame.
 */
export class WrappedTextBody implements Component {
	private cached: { readonly width: number; readonly rows: string[] } | undefined;

	constructor(
		private readonly text: string,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.rows;
		const rows = wrapTextWithAnsi(this.text, Math.max(1, width)).map((row) =>
			this.theme.fg("text", row),
		);
		this.cached = { width, rows };
		return rows;
	}

	invalidate(): void {}
}
