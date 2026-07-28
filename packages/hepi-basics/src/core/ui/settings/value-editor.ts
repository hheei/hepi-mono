import { Input } from "@earendil-works/pi-tui";

export class ValueEditor {
	readonly #input = new Input();

	constructor(text = "") {
		this.setText(text);
	}

	get text(): string {
		return this.#input.getValue();
	}

	setText(text: string): void {
		this.#input.setValue(text);
		this.#input.handleInput("\x1b[F");
	}
	handleInput(input: string): void {
		this.#input.handleInput(input);
	}
	render(width: number): string {
		const rendered = this.#input.render(width)[0] ?? "";
		return rendered.startsWith("> ") ? rendered.slice(2) : rendered;
	}
}

export function createValueEditor(text = ""): ValueEditor {
	return new ValueEditor(text);
}
