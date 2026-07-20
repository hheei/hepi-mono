import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { HePiRuntimeContext } from "../../runtime/context.js";
import { buildStatusbarSnapshot } from "./model.js";
import { renderStatusbarLine } from "./render.js";

type EditorFactory = NonNullable<
	Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
>;
type Editor = ReturnType<EditorFactory>;
type Owner = {
	sessionId: string;
	ctx: ExtensionContext;
	previousEditorFactory?: EditorFactory;
	installedEditorFactory: EditorFactory;
	footerData?: ReadonlyFooterDataProvider;
	requestRender?: () => void;
	dispose(): void;
};

export interface StatusbarFeature {
	start(runtime: HePiRuntimeContext): void;
	dispose(sessionId: string): void;
}

function emptyFooter(): Component {
	return { render: () => [], invalidate: () => undefined };
}

export function createStatusbarFeature(pi: ExtensionAPI): StatusbarFeature {
	let owner: Owner | undefined;
	const invalidate = (_event?: unknown, eventCtx?: ExtensionContext) => {
		if (owner && (!eventCtx || eventCtx === owner.ctx)) owner.requestRender?.();
	};
	for (const event of [
		"model_select",
		"thinking_level_select",
		"session_info_changed",
		"message_end",
		"session_compact",
		"session_tree",
	] as const)
		pi.on(event as never, invalidate);
	return {
		start(runtime) {
			const ctx = runtime.ctx;
			const sessionId = ctx.sessionManager.getSessionId();
			if (owner?.sessionId === sessionId) return;
			owner?.dispose();
			if (
				ctx.mode !== "tui" ||
				typeof ctx.ui.getEditorComponent !== "function" ||
				typeof ctx.ui.setEditorComponent !== "function" ||
				typeof ctx.ui.setFooter !== "function"
			)
				return;
			const previousEditorFactory = ctx.ui.getEditorComponent();
			let next!: Owner;
			const installedEditorFactory = ((tui, theme, keybindings) => {
				const editor =
					previousEditorFactory?.(tui, theme, keybindings) ??
					new CustomEditor(tui, theme, keybindings);
				const originalRender = editor.render.bind(editor);
				(editor as Editor & { render: (width: number) => string[] }).render = (width: number) => {
					const lines = originalRender(width);
					if (!lines.length || owner !== next) return lines;
					return [
						renderStatusbarLine(
							width,
							buildStatusbarSnapshot({
								model: ctx.model ? { name: ctx.model.name, id: ctx.model.id } : undefined,
								thinkingLevel: pi.getThinkingLevel(),
								usage: ctx.getContextUsage(),
								sessionName: ctx.sessionManager.getSessionName(),
								statuses: next.footerData?.getExtensionStatuses(),
							}),
							ctx.ui.theme,
						),
						...lines.slice(1),
					];
				};
				return editor;
			}) as EditorFactory;
			next = {
				sessionId,
				ctx,
				previousEditorFactory,
				installedEditorFactory,
				dispose() {
					if (owner !== next) return;
					owner = undefined;
					if (ctx.ui.getEditorComponent() === installedEditorFactory)
						ctx.ui.setEditorComponent(previousEditorFactory);
					ctx.ui.setFooter(undefined);
				},
			};
			owner = next;
			ctx.ui.setFooter((tui: TUI, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
				if (owner !== next) return emptyFooter();
				next.footerData = footerData;
				next.requestRender = () => tui.requestRender();
				return emptyFooter();
			});
			ctx.ui.setEditorComponent(installedEditorFactory);
		},
		dispose(sessionId) {
			if (owner?.sessionId === sessionId) owner.dispose();
		},
	};
}
