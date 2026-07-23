import {
	buildSessionContext,
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";
import type { HePiRuntimeContext } from "../../runtime/context.js";
import {
	buildStatusbarSnapshot,
	estimateContextUsage,
	type StatusbarContextUsage,
	stabilizeContextUsage,
} from "./model.js";
import { renderStatusbarLine } from "./render.js";

type EditorFactory = NonNullable<
	Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
>;
type Editor = ReturnType<EditorFactory>;
type Owner = {
	sessionId: string;
	ctx: ExtensionContext;
	previousEditorFactory?: EditorFactory | undefined;
	installedEditorFactory: EditorFactory;
	footerData?: ReadonlyFooterDataProvider;
	requestRender?: () => void;
	usage?: StatusbarContextUsage | undefined;
	compacted: boolean;
	dispose(): void;
};

export interface StatusbarFeature {
	start(runtime: HePiRuntimeContext): void;
	dispose(sessionId: string): void;
}

function emptyFooter(): Component {
	return { render: () => [], invalidate: () => undefined };
}

function renderBarCursor(lines: readonly string[]): string[] {
	const startMarker = `${CURSOR_MARKER}\x1b[7m`;
	const endMarker = "\x1b[0m";
	return lines.map((line) => {
		const start = line.indexOf(startMarker);
		if (start < 0) return line;
		const end = line.indexOf(endMarker, start + startMarker.length);
		if (end < 0) return line;
		return `${line.slice(0, start)}${CURSOR_MARKER}│${line.slice(end + endMarker.length)}`;
	});
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
		"session_tree",
	] as const)
		pi.on(event as never, invalidate);
	pi.on("session_compact", (_event, eventCtx) => {
		if (!owner || eventCtx !== owner.ctx) return;
		owner.usage = undefined;
		owner.compacted = true;
		owner.requestRender?.();
	});
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
			let next: Owner | undefined;
			const installedEditorFactory = ((tui, theme, keybindings) => {
				const editor =
					previousEditorFactory?.(tui, theme, keybindings) ??
					new CustomEditor(tui, theme, keybindings);
				const originalRender = editor.render.bind(editor);
				(editor as Editor & { render: (width: number) => string[] }).render = (width: number) => {
					const lines = renderBarCursor(originalRender(width));
					if (!lines.length || !next || owner !== next) return lines;
					const systemPrompt =
						typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined;
					const currentUsage = ctx.getContextUsage();
					let fallback: StatusbarContextUsage | undefined;
					if (currentUsage?.tokens == null || next.compacted) {
						try {
							const messages = buildSessionContext([
								...ctx.sessionManager.getBranch(),
							] as never).messages;
							fallback = estimateContextUsage(messages, currentUsage?.contextWindow, systemPrompt);
						} catch {
							fallback = undefined;
						}
					}
					const sessionName = ctx.sessionManager.getSessionName();
					const usage = stabilizeContextUsage(
						currentUsage,
						next.compacted ? undefined : next.usage,
						fallback,
					);
					if (usage?.tokens != null) {
						next.usage = usage;
						next.compacted = false;
					}
					const statuses = next.footerData?.getExtensionStatuses();
					return [
						renderStatusbarLine(
							width,
							buildStatusbarSnapshot({
								...(ctx.model ? { model: { name: ctx.model.name, id: ctx.model.id } } : {}),
								thinkingLevel: pi.getThinkingLevel(),
								...(usage === undefined ? {} : { usage }),
								...(systemPrompt === undefined ? {} : { systemPrompt }),
								...(sessionName === undefined ? {} : { sessionName }),
								...(statuses === undefined ? {} : { statuses }),
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
				compacted: false,
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
				if (!next || owner !== next) return emptyFooter();
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
