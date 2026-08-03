import type {
	AssistantMessageAddon,
	AssistantMessageAddonBlock,
	AssistantMessageAddonFactory,
	AssistantMessageAddonSnapshot,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import {
	installMouseSupport,
	type MouseSupport,
	type TextPosition,
	type TextRange,
} from "@hheei/pi-ext-core";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const fullSgrReset = new RegExp(`${String.fromCharCode(27)}\\[(?:0)?m`, "g");

type BlockState = {
	readonly kind: "text" | "thinking";
	layout: AssistantMessageAddonBlock["layout"];
	removeLayout: (() => void) | undefined;
	removeRegion: (() => void) | undefined;
	snapshot: AssistantMessageAddonSnapshot | undefined;
	rawRows: readonly string[];
	rows: readonly string[];
	selection: TextRange | null;
};

function terminalControlLength(text: string, start: number): number {
	if (text.charCodeAt(start) !== 27) return 0;
	const next = text[start + 1];
	if (next === "[") {
		let end = start + 2;
		while (end < text.length && !"mGKHJ".includes(text[end] ?? "")) end++;
		return end < text.length ? end + 1 - start : 0;
	}
	if (next !== "]" && next !== "_") return 0;
	for (let end = start + 2; end < text.length; end++) {
		if (text[end] === "\x07") return end + 1 - start;
		if (text[end] === "\x1b" && text[end + 1] === "\\") return end + 2 - start;
	}
	return 0;
}

function visibleText(text: string): string {
	let plain = "";
	for (let index = 0; index < text.length; ) {
		const length = terminalControlLength(text, index);
		if (length > 0) {
			index += length;
			continue;
		}
		plain += text[index] ?? "";
		index++;
	}
	return plain;
}

function graphemes(text: string): readonly string[] {
	return [...segmenter.segment(text)].map((part) => part.segment);
}

function graphemeAtCell(text: string, cell: number): number {
	let column = 0;
	const parts = graphemes(text);
	for (let index = 0; index < parts.length; index++) {
		const width = Math.max(1, visibleWidth(parts[index] ?? ""));
		if (cell < column + width) return index;
		column += width;
	}
	return parts.length;
}

function compare(left: TextPosition, right: TextPosition): number {
	return left.line === right.line ? left.grapheme - right.grapheme : left.line - right.line;
}

function selectedRange(
	selection: TextRange,
	line: number,
	length: number,
): readonly [number, number] | undefined {
	const [start, end] =
		compare(selection.start, selection.end) <= 0
			? [selection.start, selection.end]
			: [selection.end, selection.start];
	if (line < start.line || line > end.line) return undefined;
	const from = line === start.line ? Math.min(Math.max(0, start.grapheme), length) : 0;
	const to = line === end.line ? Math.min(Math.max(0, end.grapheme), length) : length;
	return from < to ? [from, to] : undefined;
}

function graphemeColumn(parts: readonly string[], end: number): number {
	let column = 0;
	for (let index = 0; index < end; index++) {
		column += visibleWidth(parts[index] ?? "");
	}
	return column;
}

function selectedBackground(theme: Theme, text: string): string {
	const sentinel = "\u0000";
	const template = theme.bg("selectedBg", sentinel);
	const index = template.indexOf(sentinel);
	if (index < 0) return theme.bg("selectedBg", text);
	const prefix = template.slice(0, index);
	const suffix = template.slice(index + sentinel.length);
	return prefix + text.replace(fullSgrReset, `$&${prefix}`) + suffix;
}

function renderSelectedRow(
	theme: Theme,
	raw: string,
	plain: string,
	selection: TextRange,
	row: number,
): string {
	const parts = graphemes(plain);
	const range = selectedRange(selection, row, parts.length);
	if (range === undefined) return raw;
	const [start, end] = range;
	const startColumn = graphemeColumn(parts, start);
	const endColumn = graphemeColumn(parts, end);
	const totalWidth = visibleWidth(raw);
	return (
		sliceByColumn(raw, 0, startColumn) +
		selectedBackground(theme, sliceByColumn(raw, startColumn, endColumn - startColumn)) +
		sliceByColumn(raw, endColumn, Math.max(0, totalWidth - endColumn))
	);
}

/**
 * Adapts Pi-owned assistant block snapshots to core mouse transport. Pi supplies
 * inner bounds already stripped of outputPad, so callbacks never infer padding.
 */
export function createAssistantSelectionAddon(): AssistantMessageAddonFactory {
	return ({ tui, component, theme }): AssistantMessageAddon => {
		let support: MouseSupport | undefined;
		let states: BlockState[] = [];

		const releaseSupportWhenIdle = (): void => {
			if (support === undefined || states.some((state) => state.removeRegion !== undefined)) return;
			support.dispose();
			support = undefined;
		};

		const ensureRegion = (state: BlockState): void => {
			const snapshot = state.snapshot;
			if (
				state.removeRegion !== undefined ||
				snapshot === undefined ||
				snapshot.bounds.width < 1 ||
				state.rows.length === 0
			)
				return;
			support ??= installMouseSupport(tui, { signal: new AbortController().signal });
			state.removeRegion = support.registerSelectableRegion({
				hitTest: (x, y): boolean => {
					const current = state.snapshot;
					return (
						current !== undefined &&
						x >= current.bounds.x &&
						x < current.bounds.x + current.bounds.width &&
						y >= current.bounds.y &&
						y < current.bounds.y + state.rows.length
					);
				},
				hitTestText: (x, y): TextPosition | null => {
					const current = state.snapshot;
					if (current === undefined) return null;
					const row = y - current.bounds.y;
					const text = state.rows[row];
					return text === undefined
						? null
						: { line: row, grapheme: graphemeAtCell(text, x - current.bounds.x) };
				},
				setSelection: (selection): void => {
					for (const current of states) current.selection = current === state ? selection : null;
				},
			});
		};

		const updateSnapshot = (
			state: BlockState,
			snapshot: AssistantMessageAddonSnapshot | undefined,
		): void => {
			state.snapshot = snapshot;
			state.rawRows = snapshot?.lines ?? [];
			state.rows = snapshot?.lines.map(visibleText) ?? [];
			if (snapshot === undefined || snapshot.bounds.width < 1 || state.rows.length === 0) {
				state.removeRegion?.();
				state.removeRegion = undefined;
				state.selection = null;
				releaseSupportWhenIdle();
				return;
			}
			ensureRegion(state);
		};

		const disposeState = (state: BlockState): void => {
			state.removeLayout?.();
			state.removeLayout = undefined;
			state.removeRegion?.();
			state.removeRegion = undefined;
		};

		return {
			setBlocks(blocks: readonly AssistantMessageAddonBlock[]): void {
				const next: BlockState[] = [];
				for (let index = 0; index < blocks.length; index++) {
					const block = blocks[index];
					if (block === undefined) continue;
					const prior = states[index];
					const state =
						prior !== undefined && prior.kind === block.kind
							? prior
							: {
									kind: block.kind,
									layout: block.layout,
									removeLayout: undefined,
									removeRegion: undefined,
									snapshot: undefined,
									rawRows: [],
									rows: [],
									selection: null,
								};
					if (state !== prior) disposeState(prior ?? state);
					state.removeLayout?.();
					state.removeLayout = undefined;
					state.layout = block.layout;
					// Streaming recreates Markdown before TUI has a new layout snapshot.
					// Keep a captured region on its last valid geometry until Pi publishes
					// the replacement block; clearing it here would drop drag/up mid-gesture.
					if (state === prior && block.layout.snapshot === undefined) {
						// Subscription below owns the eventual snapshot replacement.
					} else {
						updateSnapshot(state, block.layout.snapshot);
					}
					state.removeLayout = block.layout.onChange((snapshot) => updateSnapshot(state, snapshot));
					next.push(state);
				}
				for (let index = next.length; index < states.length; index++) {
					const stale = states[index];
					if (stale !== undefined) disposeState(stale);
				}
				states = next;
				releaseSupportWhenIdle();
			},
			setOutputPad(_padding: number): void {
				// Pi publishes content bounds after padding; there is nothing to recompute here.
			},
			render(lines: readonly string[], width: number): string[] {
				const componentBounds = tui.getComponentBounds(component);
				if (componentBounds === undefined) return [...lines];
				const rendered = [...lines];
				for (const state of states) {
					const snapshot = state.snapshot;
					if (snapshot === undefined || state.selection === null) continue;
					const left = Math.max(0, snapshot.bounds.x - componentBounds.x);
					const firstRow = snapshot.bounds.y - componentBounds.y;
					for (let row = 0; row < state.rows.length; row++) {
						const lineIndex = firstRow + row;
						if (lineIndex < 0 || lineIndex >= rendered.length) continue;
						const raw = state.rawRows[row] ?? "";
						const text = state.rows[row] ?? "";
						const line =
							" ".repeat(left) + renderSelectedRow(theme, raw, text, state.selection, row);
						rendered[lineIndex] = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
					}
				}
				return rendered;
			},
			dispose(): void {
				for (const state of states) disposeState(state);
				states = [];
				support?.dispose();
				support = undefined;
			},
		};
	};
}
