import { Editor, type EditorComponent, getKeybindings } from "@earendil-works/pi-tui";
import type { DollarSkillCommand } from "./model.js";

const ATOMIC_REFERENCE_PATTERN = /(^|[\s([{])\$([A-Za-z][A-Za-z0-9-]*)(?=$|[^A-Za-z0-9:-])/g;
const PASTE_MARKER_PREFIX = "[paste #";
const CURSOR_LEFT_INPUTS = ["\x1b[D", "\x02"] as const;

type AtomicAction = "left" | "right" | "backspace" | "delete";
type AtomicKeybinding =
	| "tui.editor.cursorLeft"
	| "tui.editor.cursorRight"
	| "tui.editor.deleteCharBackward"
	| "tui.editor.deleteCharForward";

interface AtomicSpan {
	readonly start: number;
	readonly end: number;
}

interface CursorEditor extends EditorComponent {
	getLines(): string[];
	getCursor(): { line: number; col: number };
}

interface KeybindingsLike {
	matches(data: string, keybinding: AtomicKeybinding): boolean;
	getKeys?(keybinding: AtomicKeybinding): readonly string[];
}

function bareSkillName(name: string): string {
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

function isCursorEditor(editor: EditorComponent): editor is CursorEditor {
	return (
		"getLines" in editor &&
		typeof editor.getLines === "function" &&
		"getCursor" in editor &&
		typeof editor.getCursor === "function"
	);
}

function actionForInput(data: string, keybindings: KeybindingsLike): AtomicAction | undefined {
	if (keybindings.matches(data, "tui.editor.cursorLeft")) return "left";
	if (keybindings.matches(data, "tui.editor.cursorRight")) return "right";
	if (keybindings.matches(data, "tui.editor.deleteCharBackward")) return "backspace";
	if (keybindings.matches(data, "tui.editor.deleteCharForward")) return "delete";
	return undefined;
}

function knownSkillNames(commands: readonly DollarSkillCommand[]): ReadonlySet<string> {
	return new Set(
		commands
			.filter((command) => command.source === "skill")
			.map((command) => bareSkillName(command.name))
			.filter((name) => name.length > 0),
	);
}

function matchingSpan(
	line: string,
	cursorCol: number,
	action: AtomicAction,
	commands: readonly DollarSkillCommand[],
): AtomicSpan | undefined {
	const names = knownSkillNames(commands);
	for (const match of line.matchAll(ATOMIC_REFERENCE_PATTERN)) {
		const boundary = match[1] ?? "";
		const name = match[2];
		if (name === undefined || !names.has(name)) continue;
		const start = match.index + boundary.length;
		const end = start + name.length + 1;
		const matches = (() => {
			switch (action) {
				case "left":
					return start < cursorCol && cursorCol <= end;
				case "right":
					return start <= cursorCol && cursorCol < end;
				case "backspace":
					return start < cursorCol && cursorCol <= end;
				case "delete":
					return start <= cursorCol && cursorCol < end;
				default: {
					const exhaustive: never = action;
					return exhaustive;
				}
			}
		})();
		if (matches) return { start, end };
	}
	return undefined;
}

function inputCount(action: AtomicAction, cursorCol: number, span: AtomicSpan): number {
	switch (action) {
		case "left":
			return cursorCol - span.start;
		case "right":
			return span.end - cursorCol;
		case "backspace":
		case "delete":
			return span.end - span.start;
		default: {
			const exhaustive: never = action;
			return exhaustive;
		}
	}
}

function keyIdToInput(keyId: string): string | undefined {
	if (keyId === "left") return "\x1b[D";
	if (keyId.length === 1) return keyId;
	const control = /^ctrl\+([a-z])$/.exec(keyId);
	if (control?.[1]) return String.fromCharCode(control[1].charCodeAt(0) & 0x1f);
	const alternate = /^alt\+([a-z])$/.exec(keyId);
	if (alternate?.[1]) return `\x1b${alternate[1]}`;
	const parts = keyId.split("+");
	if (parts.at(-1) !== "left") return undefined;
	let modifier = 1;
	for (const part of parts.slice(0, -1)) {
		if (part === "shift") modifier += 1;
		else if (part === "alt") modifier += 2;
		else if (part === "ctrl") modifier += 4;
		else return undefined;
	}
	return `\x1b[1;${modifier}D`;
}

function cursorLeftInput(keybindings: KeybindingsLike): string | undefined {
	for (const input of CURSOR_LEFT_INPUTS) {
		if (keybindings.matches(input, "tui.editor.cursorLeft")) return input;
	}
	for (const keyId of keybindings.getKeys?.("tui.editor.cursorLeft") ?? []) {
		const input = keyIdToInput(keyId);
		if (input !== undefined && keybindings.matches(input, "tui.editor.cursorLeft")) return input;
	}
	return undefined;
}

function deleteAtomically(
	editor: CursorEditor,
	cursorLine: number,
	span: AtomicSpan,
	handleInput: (data: string) => void,
): boolean {
	if (!(editor instanceof Editor) || editor.getText().includes(PASTE_MARKER_PREFIX)) return false;
	const lines = editor.getLines();
	const line = lines[cursorLine];
	if (line === undefined) return false;
	const nextLines = [...lines];
	nextLines[cursorLine] = `${line.slice(0, span.start)}${line.slice(span.end)}`;
	const finalLine = nextLines.length - 1;
	const finalCol = nextLines[finalLine]?.length ?? 0;
	const needsCursorRestore = finalLine !== cursorLine || finalCol !== span.start;
	const leftInput = needsCursorRestore ? cursorLeftInput(getKeybindings()) : undefined;
	if (needsCursorRestore && leftInput === undefined) return false;

	editor.setText(nextLines.join("\n"));
	if (leftInput === undefined) return true;
	const maxMoves = editor.getText().length + nextLines.length;
	for (let move = 0; move <= maxMoves; move += 1) {
		const cursor = editor.getCursor();
		if (cursor.line === cursorLine && cursor.col === span.start) return true;
		handleInput(leftInput);
	}
	return true;
}

export function createDollarSkillAtomicEditor(
	editor: EditorComponent,
	keybindings: KeybindingsLike,
	getCommands: () => readonly DollarSkillCommand[],
	isEnabled: () => boolean,
): EditorComponent {
	if (!isCursorEditor(editor)) return editor;
	const handleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data: string): void => {
		const action = isEnabled() ? actionForInput(data, keybindings) : undefined;
		if (action !== undefined) {
			const cursor = editor.getCursor();
			const line = editor.getLines()[cursor.line] ?? "";
			const span = matchingSpan(line, cursor.col, action, getCommands());
			if (span !== undefined) {
				if (
					(action === "backspace" || action === "delete") &&
					deleteAtomically(editor, cursor.line, span, handleInput)
				)
					return;
				const isDeleteEdge =
					(action === "backspace" && cursor.col === span.end) ||
					(action === "delete" && cursor.col === span.start);
				if (action === "left" || action === "right" || isDeleteEdge) {
					for (let index = 0; index < inputCount(action, cursor.col, span); index += 1)
						handleInput(data);
					return;
				}
			}
		}
		handleInput(data);
	};
	return editor;
}
