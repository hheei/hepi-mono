import type { Component } from "@earendil-works/pi-tui";

export class LinesBody implements Component {
	private cached: { readonly width: number; readonly rows: string[] } | undefined;

	constructor(private readonly paint: (width: number) => string[]) {}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.rows;
		const rows = this.paint(width);
		this.cached = { width, rows };
		return rows;
	}

	invalidate(): void {}
}
