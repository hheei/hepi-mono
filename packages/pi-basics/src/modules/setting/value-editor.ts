import { horizontalViewport, visibleWidth } from "../../ui/text.js";

function graphemeBoundaries(text: string): number[] {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const boundaries = [0];
	for (const segment of segmenter.segment(text))
		boundaries.push(segment.index + segment.segment.length);
	return boundaries;
}

export interface ValueEditorState {
	readonly text: string;
	readonly cursor: number;
	readonly viewport: number;
}

export class ValueEditor {
	text: string;
	cursor: number;
	viewport: number;
	constructor(text = "") {
		this.text = text;
		this.cursor = text.length;
		this.viewport = 0;
	}
	get state(): ValueEditorState {
		return { text: this.text, cursor: this.cursor, viewport: this.viewport };
	}
	setText(text: string): void {
		this.text = text;
		const boundaries = graphemeBoundaries(text);
		this.cursor = boundaries.reduce(
			(last, boundary) => (boundary <= this.cursor ? boundary : last),
			0,
		);
		this.viewport = 0;
	}
	insert(text: string): void {
		this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
		this.cursor += text.length;
	}
	backspace(): void {
		const boundaries = graphemeBoundaries(this.text);
		const index = boundaries.indexOf(this.cursor);
		if (index > 0) {
			const start = boundaries[index - 1] ?? 0;
			this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
			this.cursor = start;
		}
	}
	delete(): void {
		const boundaries = graphemeBoundaries(this.text);
		const index = boundaries.indexOf(this.cursor);
		if (index >= 0 && index < boundaries.length - 1) {
			const end = boundaries[index + 1];
			this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
		}
	}
	move(delta: number): void {
		const boundaries = graphemeBoundaries(this.text);
		const current = Math.max(0, boundaries.indexOf(this.cursor));
		this.cursor =
			boundaries[Math.max(0, Math.min(boundaries.length - 1, current + delta))] ?? this.cursor;
	}
	home(): void {
		this.cursor = 0;
	}
	end(): void {
		this.cursor = this.text.length;
	}
	handleInput(input: string): boolean {
		switch (input) {
			case "\x1b[D":
			case "\u001bOD":
				this.move(-1);
				return true;
			case "\x1b[C":
			case "\u001bOC":
				this.move(1);
				return true;
			case "\x1b[H":
			case "\x01":
				this.home();
				return true;
			case "\x1b[F":
			case "\x05":
				this.end();
				return true;
			case "\x7f":
			case "\b":
				this.backspace();
				return true;
			case "\x1b[3~":
				this.delete();
				return true;
			default:
				if (input.length > 0 && !input.startsWith("\x1b")) {
					this.insert(input);
					return true;
				}
				return false;
		}
	}
	visible(width: number): string {
		if (width <= 0) return "";
		const cursorColumn = visibleWidth(this.text.slice(0, this.cursor));
		const target = this.cursor === this.text.length ? Math.max(0, cursorColumn - 1) : cursorColumn;
		const view = horizontalViewport(this.text, width, target);
		this.viewport = view.offset;
		return view.text;
	}
}

export function createValueEditor(text = ""): ValueEditor {
	return new ValueEditor(text);
}
