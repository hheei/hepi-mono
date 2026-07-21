import { extractDollarSkillToken, renderSkillPickerLines } from "./picker.js";
import { highlightDollarSkillReferences } from "./references.js";
import { DEFAULT_DOLLAR_SETTINGS, type DollarExtensionSettings } from "./settings.js";
import { getSkillSuggestions } from "./skills.js";
import { clamp } from "./text.js";
import type {
	DollarTheme,
	EditorLike,
	KeybindingsLike,
	PickerState,
	SkillCommand,
	SymbolMetadata,
	TuiLike,
} from "./types.js";

const HIGHLIGHT_WRAPPED = Symbol.for("pi-codex-dollar.highlightWrapped");
const HIGHLIGHT_BASE_EDITOR = Symbol.for("pi-codex-dollar.highlightBaseEditor");

function getPickerState(
	baseEditor: EditorLike,
	commands: readonly SkillCommand[],
	maxSuggestions: number,
): PickerState | null {
	if (typeof baseEditor.getLines !== "function" || typeof baseEditor.getCursor !== "function")
		return null;
	const cursor = baseEditor.getCursor();
	const token = extractDollarSkillToken(baseEditor.getLines(), cursor.line, cursor.col);
	if (!token) return null;

	const items = getSkillSuggestions(commands, token.query, maxSuggestions);
	if (items.length === 0) return null;

	return { token, items };
}

export function createSkillPickerEditor(
	baseEditor: EditorLike,
	getCommands: () => readonly SkillCommand[],
	theme: DollarTheme,
	tui: TuiLike,
	keybindings?: KeybindingsLike,
	getSettings?: () => DollarExtensionSettings,
): EditorLike {
	const editorMetadata = baseEditor as unknown as SymbolMetadata;
	if (editorMetadata[HIGHLIGHT_WRAPPED]) return baseEditor;
	const unwrappedEditor = editorMetadata[HIGHLIGHT_BASE_EDITOR];
	if (isEditorLike(unwrappedEditor)) baseEditor = unwrappedEditor;

	const state: { selectedIndex: number; lastPrefix?: string; closedPrefix?: string } = {
		selectedIndex: 0,
	};

	function currentPicker(): PickerState | null {
		const settings = getSettings?.() ?? DEFAULT_DOLLAR_SETTINGS;
		if (!settings.pickerEnabled) return null;
		const picker = getPickerState(baseEditor, getCommands(), settings.maxSuggestions);
		if (!picker) return null;
		if (state.closedPrefix === picker.token.prefix) return null;

		if (state.lastPrefix !== picker.token.prefix) {
			state.selectedIndex = 0;
			state.lastPrefix = picker.token.prefix;
			state.closedPrefix = undefined;
		}

		state.selectedIndex = clamp(state.selectedIndex, 0, picker.items.length - 1);
		return picker;
	}

	function requestRender() {
		if (typeof tui?.requestRender === "function") tui.requestRender();
	}

	function pickerLineLimit(): number | undefined {
		const candidates = [
			tui?.height,
			tui?.rows,
			tui?.terminal?.height,
			tui?.terminal?.rows,
			process.stdout?.rows,
		];
		const height = candidates.find(
			(value): value is number => typeof value === "number" && value > 0,
		);
		return height ? Math.max(3, Math.floor(height * 0.3)) : undefined;
	}

	function matchesInput(data: string, action: string, fallbacks: readonly string[]): boolean {
		if (typeof keybindings?.matches === "function" && keybindings.matches(data, action))
			return true;
		return fallbacks.includes(data);
	}

	function applySelection(picker: PickerState): void {
		const selected = picker.items[state.selectedIndex];
		if (!selected) return;

		const deleteCount = picker.token.prefix.length;
		for (let i = 0; i < deleteCount; i += 1) {
			baseEditor.handleInput("\x7f");
		}

		const insertion = `${selected.value} `;

		if (typeof baseEditor.insertTextAtCursor === "function") {
			baseEditor.insertTextAtCursor(insertion);
		} else {
			for (const char of insertion) baseEditor.handleInput(char);
		}

		state.closedPrefix = undefined;
		state.lastPrefix = undefined;
		requestRender();
	}

	return new Proxy(baseEditor, {
		get(target, prop) {
			if (prop === HIGHLIGHT_WRAPPED) return true;
			if (prop === HIGHLIGHT_BASE_EDITOR) return baseEditor;
			if (prop === "handleInput") {
				return (data: string) => {
					const picker = currentPicker();

					if (picker) {
						if (matchesInput(data, "tui.select.up", ["\x1b[A"])) {
							state.selectedIndex =
								state.selectedIndex <= 0 ? picker.items.length - 1 : state.selectedIndex - 1;
							requestRender();
							return;
						}
						if (matchesInput(data, "tui.select.down", ["\x1b[B"])) {
							state.selectedIndex =
								state.selectedIndex >= picker.items.length - 1 ? 0 : state.selectedIndex + 1;
							requestRender();
							return;
						}
						if (
							matchesInput(data, "tui.select.confirm", ["\r", "\n"]) ||
							matchesInput(data, "tui.input.tab", ["\t"])
						) {
							applySelection(picker);
							return;
						}
						if (matchesInput(data, "tui.select.cancel", ["\x1b"])) {
							state.closedPrefix = picker.token.prefix;
							requestRender();
							return;
						}
					}

					target.handleInput(data);
					const settings = getSettings?.() ?? DEFAULT_DOLLAR_SETTINGS;
					const nextPicker = settings.pickerEnabled
						? getPickerState(target, getCommands(), settings.maxSuggestions)
						: null;
					if (!nextPicker || nextPicker.token.prefix !== state.closedPrefix)
						state.closedPrefix = undefined;
				};
			}

			if (prop === "render") {
				return (width: number) => {
					const settings = getSettings?.() ?? DEFAULT_DOLLAR_SETTINGS;
					const baseLines = target
						.render(width)
						.map((line) =>
							settings.highlightReferences
								? highlightDollarSkillReferences(line, getCommands(), theme)
								: line,
						);
					const picker = currentPicker();
					if (!picker) return baseLines;
					return [
						...baseLines,
						...renderSkillPickerLines(
							picker.items,
							state.selectedIndex,
							width,
							theme,
							pickerLineLimit(),
						),
					];
				};
			}

			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},

		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	});
}

function isEditorLike(value: unknown): value is EditorLike {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		typeof (value as Partial<EditorLike>).handleInput === "function" &&
		typeof (value as Partial<EditorLike>).render === "function" &&
		typeof (value as Partial<EditorLike>).getLines === "function" &&
		typeof (value as Partial<EditorLike>).getCursor === "function"
	);
}
