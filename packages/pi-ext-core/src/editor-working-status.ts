import { truncateToWidth } from "@earendil-works/pi-tui";
import { getGlobalState } from "./global-state.js";
export interface WorkingStatusThemeLike {
	fg?(color: string, text: string): string;
	borderColor?: ((text: string) => string) | undefined;
}

export const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface EditorWorkingStatusIndicatorLike {
	renderInBorder(width: number): string;
	renderSpinnerInBorder?(width: number): string;
	dispose?(): void;
	stop?(): void;
}

export interface CustomEditorLike {
	setWorkingStatusIndicator?(indicator: EditorWorkingStatusIndicatorLike | undefined): void;
	workingStatusIndicator?: EditorWorkingStatusIndicatorLike | undefined;
	renderTopBorder?(width: number, hiddenLineCount: number): string;
}

export interface TuiLike {
	requestRender(): void;
}

export class EditorWorkingStatusIndicator implements EditorWorkingStatusIndicatorLike {
	readonly #ui: TuiLike;
	readonly #message: string;
	readonly #spinnerColorFn: (text: string) => string;
	readonly #messageColorFn: (text: string) => string;
	#timer: NodeJS.Timeout | undefined;
	#frameIndex = 0;

	constructor(
		ui: TuiLike,
		message = "Recalling",
		spinnerColorFn?: (text: string) => string,
		messageColorFn?: (text: string) => string,
	) {
		this.#ui = ui;
		this.#message = message;
		this.#spinnerColorFn = spinnerColorFn ?? ((text) => text);
		this.#messageColorFn = messageColorFn ?? ((text) => text);
		this.#timer = setInterval(() => {
			this.#frameIndex = (this.#frameIndex + 1) % BRAILLE_SPINNER_FRAMES.length;
			this.#ui.requestRender();
		}, 80);
		this.#timer.unref?.();
	}

	renderInBorder(width: number): string {
		const frame = this.#spinnerColorFn(BRAILLE_SPINNER_FRAMES[this.#frameIndex] ?? "⠋");
		const msg = this.#messageColorFn(this.#message);
		return truncateToWidth(`${frame} ${msg}`, width, "");
	}

	renderSpinnerInBorder(width: number): string {
		const frame = this.#spinnerColorFn(BRAILLE_SPINNER_FRAMES[this.#frameIndex] ?? "⠋");
		return truncateToWidth(frame, width, "");
	}

	dispose(): void {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}
}

interface EditorWorkingState {
	activeEditor?: CustomEditorLike | undefined;
	activeTui?: TuiLike | undefined;
	activeTheme?: WorkingStatusThemeLike | undefined;
	currentIndicator?: EditorWorkingStatusIndicator | undefined;
}

function getEditorWorkingState(): EditorWorkingState {
	return getGlobalState<EditorWorkingState>("editor-working-state", () => ({}));
}

export function registerActiveEditor(
	editor: CustomEditorLike,
	tui: TuiLike,
	theme?: WorkingStatusThemeLike | undefined,
): void {
	const state = getEditorWorkingState();
	state.activeEditor = editor;
	state.activeTui = tui;
	state.activeTheme = theme;
}

export function unregisterActiveEditor(editor: CustomEditorLike): void {
	const state = getEditorWorkingState();
	if (state.activeEditor === editor) {
		state.currentIndicator?.dispose();
		state.currentIndicator = undefined;
		state.activeEditor = undefined;
		state.activeTui = undefined;
		state.activeTheme = undefined;
	}
}

export interface PreTurnWorkingStatusOptions {
	readonly spinnerColorFn?: (text: string) => string;
	readonly messageColorFn?: (text: string) => string;
}

/**
 * Temporarily displays a working spinner in the editor's top border (e.g. "⠋ Recalling")
 * before the Pi agent loop officially starts and takes over the working status indicator.
 * Returns a cleanup function that disposes the timer and restores the border.
 */
export function setPreTurnWorkingStatus(
	message = "Recalling",
	options?: PreTurnWorkingStatusOptions,
): () => void {
	const state = getEditorWorkingState();
	const editor = state.activeEditor;
	const tui = state.activeTui;
	if (!editor || !tui || typeof editor.setWorkingStatusIndicator !== "function") {
		return () => {};
	}

	state.currentIndicator?.dispose();
	const theme = state.activeTheme;
	const spinnerColor =
		options?.spinnerColorFn ??
		((text) =>
			theme?.fg !== undefined
				? theme.fg("accent", text)
				: theme?.borderColor !== undefined
					? theme.borderColor(text)
					: text);
	const messageColor =
		options?.messageColorFn ??
		((text) => (theme?.fg !== undefined ? theme.fg("muted", text) : text));

	const indicator = new EditorWorkingStatusIndicator(tui, message, spinnerColor, messageColor);
	state.currentIndicator = indicator;
	editor.setWorkingStatusIndicator(indicator);
	tui.requestRender();

	return () => {
		if (state.currentIndicator === indicator) {
			indicator.dispose();
			state.currentIndicator = undefined;
			if (
				editor.workingStatusIndicator === indicator &&
				typeof editor.setWorkingStatusIndicator === "function"
			) {
				editor.setWorkingStatusIndicator(undefined);
			}
			tui.requestRender();
		}
	};
}
