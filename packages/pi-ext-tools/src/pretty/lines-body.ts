import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export class LinesBody implements Component {
	private cached: { readonly width: number; readonly rows: string[] } | undefined;

	constructor(private readonly paint: (width: number) => string[]) {}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.rows;
		if (width <= 0) {
			this.cached = { width, rows: [] };
			return [];
		}
		const rows = this.paint(width).map((line) => {
			let rendered = truncateToWidth(line, width, "...");
			while (visibleWidth(rendered) > width) {
				rendered = truncateToWidth(rendered, width - 1, "...");
			}
			return rendered;
		});
		this.cached = { width, rows };
		return rows;
	}

	invalidate(): void {}
}
