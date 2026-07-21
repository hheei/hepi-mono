import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

type EditorUi = ExtensionContext["ui"];
type NativeEditorFactory = NonNullable<ReturnType<NonNullable<EditorUi["getEditorComponent"]>>>;

export interface EditorHostContext {
	mode?: string;
	ui: {
		getEditorComponent?: EditorUi["getEditorComponent"];
		setEditorComponent?: EditorUi["setEditorComponent"];
	};
}

export type EditorComponentFactory = NativeEditorFactory;

export type EditorComponent = ReturnType<EditorComponentFactory>;
export type EditorTui = Parameters<EditorComponentFactory>[0];
export type EditorTheme = Parameters<EditorComponentFactory>[1];
export type EditorKeybindings = Parameters<EditorComponentFactory>[2];

export interface EditorModifierContext {
	tui: EditorTui;
	theme: EditorTheme;
	keybindings: EditorKeybindings;
	previousEditor?: EditorComponent;
}

export type EditorModifier = (
	baseEditor: EditorComponent,
	context: EditorModifierContext,
) => EditorComponent;

export function registerEditorModifier(ctx: EditorHostContext, modifier: EditorModifier): boolean {
	if (ctx.mode !== "tui" || typeof ctx.ui.setEditorComponent !== "function") return false;

	const previousEditorFactory = ctx.ui.getEditorComponent?.();
	ctx.ui.setEditorComponent(((
		tui: EditorTui,
		theme: EditorTheme,
		keybindings: EditorKeybindings,
	) => {
		const previousEditor = previousEditorFactory?.(tui, theme, keybindings) as
			| EditorComponent
			| undefined;
		const baseEditor = previousEditor ?? new CustomEditor(tui, theme, keybindings);
		return modifier(baseEditor, {
			tui,
			theme,
			keybindings,
			previousEditor,
		});
	}) as NativeEditorFactory);

	return true;
}
