import { describe, expect, test } from "bun:test";
import { Editor, type EditorComponent, getKeybindings } from "@earendil-works/pi-tui";
import { createDollarSkillAtomicEditor } from "../src/atomic-editor.js";
import type { DollarSkillCommand } from "../src/model.js";

const commands: readonly DollarSkillCommand[] = [
	{ name: "skill:librarian", source: "skill" },
	{ name: "deploy-plan", source: "skill" },
	{ name: "review", source: "extension" },
];

const inputs = {
	left: "<left>",
	right: "<right>",
	backspace: "<backspace>",
	delete: "<delete>",
} as const;

const keybindings = {
	matches(data: string, action: string): boolean {
		switch (action) {
			case "tui.editor.cursorLeft":
				return data === inputs.left;
			case "tui.editor.cursorRight":
				return data === inputs.right;
			case "tui.editor.deleteCharBackward":
				return data === inputs.backspace;
			case "tui.editor.deleteCharForward":
				return data === inputs.delete;
			default:
				return false;
		}
	},
};

class FakeEditor implements EditorComponent {
	private text: string;
	private cursorCol: number;
	readonly calls: string[] = [];

	constructor(text: string, cursorCol: number) {
		this.text = text;
		this.cursorCol = cursorCol;
	}

	render(): string[] {
		return [this.text];
	}

	invalidate(): void {}

	getText(): string {
		return this.text;
	}

	getLines(): string[] {
		return [this.text];
	}

	getCursor(): { line: number; col: number } {
		return { line: 0, col: this.cursorCol };
	}

	setText(text: string): void {
		this.text = text;
		this.cursorCol = text.length;
	}

	handleInput(data: string): void {
		this.calls.push(data);
		switch (data) {
			case inputs.left:
				this.cursorCol = Math.max(0, this.cursorCol - 1);
				break;
			case inputs.right:
				this.cursorCol = Math.min(this.text.length, this.cursorCol + 1);
				break;
			case inputs.backspace:
				if (this.cursorCol > 0) {
					this.text = `${this.text.slice(0, this.cursorCol - 1)}${this.text.slice(this.cursorCol)}`;
					this.cursorCol--;
				}
				break;
			case inputs.delete:
				this.text = `${this.text.slice(0, this.cursorCol)}${this.text.slice(this.cursorCol + 1)}`;
				break;
		}
	}
}

function atomicEditor(
	text: string,
	cursorCol: number,
	enabled = true,
): { base: FakeEditor; editor: EditorComponent } {
	const base = new FakeEditor(text, cursorCol);
	return {
		base,
		editor: createDollarSkillAtomicEditor(
			base,
			keybindings,
			() => commands,
			() => enabled,
		),
	};
}

describe("dollar skill atomic editor", () => {
	test("deletes as one real Editor change and undo snapshot from inside a multiline token", () => {
		const keybindings = getKeybindings();
		const base = new Editor({ requestRender() {}, terminal: { rows: 24 } } as never, {
			borderColor: (text: string) => text,
			selectList: {
				selectedPrefix: (text: string) => text,
				selectedText: (text: string) => text,
				description: (text: string) => text,
				scrollInfo: (text: string) => text,
				noMatch: (text: string) => text,
			},
		});
		base.setText("first line\n$librarian next");
		while (base.getCursor().col > 5) base.handleInput("\x1b[D");
		let changes = 0;
		base.onChange = () => {
			changes++;
		};
		const editor = createDollarSkillAtomicEditor(
			base,
			keybindings,
			() => commands,
			() => true,
		);

		editor.handleInput("\x7f");
		expect(base.getText()).toBe("first line\n next");
		expect(base.getCursor()).toEqual({ line: 1, col: 0 });
		expect(changes).toBe(1);

		base.handleInput("\x1f");
		expect(base.getText()).toBe("first line\n$librarian next");
		expect(base.getCursor()).toEqual({ line: 1, col: 5 });

		const changesBeforeDelete = changes;
		editor.handleInput("\x1b[3~");
		expect(base.getText()).toBe("first line\n next");
		expect(base.getCursor()).toEqual({ line: 1, col: 0 });
		expect(changes).toBe(changesBeforeDelete + 1);
		base.handleInput("\x1f");
		expect(base.getText()).toBe("first line\n$librarian next");
	});

	test("moves across a known reference as one token", () => {
		const { base, editor } = atomicEditor("Use ($librarian), now", 15);
		editor.handleInput(inputs.left);
		expect(base.getCursor()).toEqual({ line: 0, col: 5 });
		expect(base.calls).toHaveLength(10);

		editor.handleInput(inputs.right);
		expect(base.getCursor()).toEqual({ line: 0, col: 15 });
		expect(base.calls).toHaveLength(20);
	});

	test("deletes a known reference from either edge", () => {
		const backward = atomicEditor("Use $librarian now", 14);
		backward.editor.handleInput(inputs.backspace);
		expect(backward.base.getText()).toBe("Use  now");
		expect(backward.base.getCursor()).toEqual({ line: 0, col: 4 });

		const forward = atomicEditor("Use $deploy-plan now", 4);
		forward.editor.handleInput(inputs.delete);
		expect(forward.base.getText()).toBe("Use  now");
		expect(forward.base.getCursor()).toEqual({ line: 0, col: 4 });

		const punctuation = atomicEditor("$librarian,", 10);
		punctuation.editor.handleInput(inputs.backspace);
		expect(punctuation.base.getText()).toBe(",");
		expect(punctuation.base.getCursor()).toEqual({ line: 0, col: 0 });
	});

	test("keeps partial, unknown, and non-skill tokens character-based", () => {
		for (const text of ["$lib", "$unknown", "$review"]) {
			const { base, editor } = atomicEditor(text, text.length);
			editor.handleInput(inputs.left);
			expect(base.getCursor().col).toBe(text.length - 1);
			expect(base.calls).toEqual([inputs.left]);
		}
	});

	test("delegates unchanged when disabled", () => {
		const { base, editor } = atomicEditor("$librarian", 10, false);
		editor.handleInput(inputs.backspace);
		expect(base.getText()).toBe("$libraria");
		expect(base.calls).toEqual([inputs.backspace]);
	});
});
