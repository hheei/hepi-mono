import type { Component } from "@earendil-works/pi-tui";

export class LinesBody implements Component {
	constructor(private readonly paint: (width: number) => string[]) {}

	render(width: number): string[] {
		return this.paint(width);
	}

	invalidate(): void {}
}
