import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	installMouseSupport,
	type TextRange,
	type ToolResultBounds,
	type ToolResultLayout,
} from "@hheei/pi-ext-core";
import {
	type LogicalText,
	logicalText,
	positionAt,
	sliceLine,
	softWrap,
	type WrappedLine,
} from "./selection.js";

/** Pi-layout-bound read result; never discovers component positions itself. */
export class SelectableReadResult implements Component {
	private text: LogicalText = logicalText("");
	private theme: Theme | undefined;
	private selection: TextRange | null = null;
	private removeLayout: (() => void) | undefined;
	private removeRegion: (() => void) | undefined;

	setResult(text: string, theme: Theme): void {
		this.text = logicalText(text);
		this.theme = theme;
		this.selection = null;
	}

	bindLayout(resultLayout: ToolResultLayout | undefined, offsetY = 0): void {
		this.removeLayout?.();
		this.removeLayout = undefined;
		this.removeRegion?.();
		this.removeRegion = undefined;
		if (resultLayout === undefined) return;
		let currentBounds: ToolResultBounds | undefined;
		let rows: readonly WrappedLine[] = [];
		const registerRegion = (): void => {
			const support = installMouseSupport(resultLayout.tui, {
				signal: new AbortController().signal,
			});
			const remove = support.registerSelectableRegion({
				hitTest: (x, y): boolean =>
					currentBounds !== undefined &&
					rows.length > 0 &&
					x >= currentBounds.x &&
					x < currentBounds.x + currentBounds.width &&
					y >= currentBounds.y + offsetY &&
					y < currentBounds.y + offsetY + rows.length,
				hitTestText: (x, y) => {
					if (currentBounds === undefined) return null;
					return positionAt(this.text, rows, y - currentBounds.y - offsetY, x - currentBounds.x);
				},
				setSelection: (selection): void => {
					this.selection = selection;
				},
			});
			this.removeRegion = (): void => {
				remove();
				support.dispose();
			};
		};
		this.removeLayout = resultLayout.onChange((nextBounds) => {
			// Down requests a render. Replacing a captured entry here would drop the
			// following drag, so only update the layout snapshot between binds.
			currentBounds = nextBounds;
			if (nextBounds === undefined || nextBounds.width < 1 || nextBounds.height <= offsetY) {
				rows = [];
				return;
			}
			rows = softWrap(this.text, nextBounds.width);
			if (rows.length > 0 && this.removeRegion === undefined) registerRegion();
		});
	}

	render(width: number): string[] {
		const theme = this.theme;
		if (theme === undefined) return [];
		return softWrap(this.text, width).map((row) =>
			this.renderRow(row.logicalLine, row.startGrapheme, row.endGrapheme, theme),
		);
	}

	invalidate(): void {}

	dispose(): void {
		this.removeLayout?.();
		this.removeRegion?.();
	}

	hasSelection(): boolean {
		return this.selection !== null;
	}

	private renderRow(line: number, start: number, end: number, theme: Theme): string {
		const source = this.text.lines[line] ?? "";
		const selection = this.selection;
		if (selection === null || line < selection.start.line || line > selection.end.line)
			return theme.fg("toolOutput", sliceLine(source, start, end));
		const selectedStart =
			line === selection.start.line ? Math.max(start, selection.start.grapheme) : start;
		const selectedEnd = line === selection.end.line ? Math.min(end, selection.end.grapheme) : end;
		return selectedStart >= selectedEnd
			? theme.fg("toolOutput", sliceLine(source, start, end))
			: theme.fg("toolOutput", sliceLine(source, start, selectedStart)) +
					theme.bg("selectedBg", sliceLine(source, selectedStart, selectedEnd)) +
					theme.fg("toolOutput", sliceLine(source, selectedEnd, end));
	}
}
