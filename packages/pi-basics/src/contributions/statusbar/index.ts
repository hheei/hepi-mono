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
import { type CursorOptions, cursorEscape } from "./cursor.js";
import {
	buildStatusbarSnapshot,
	estimateContextUsage,
	formatFooterStatuses,
	RECEIVING_SPINNER_FRAMES,
	type StatusbarContextUsage,
	stabilizeContextUsage,
} from "./model.js";
import { renderExtensionStatusFooter, renderStatusbarLine } from "./render.js";

type EditorFactory = NonNullable<
	Parameters<NonNullable<ExtensionContext["ui"]["setEditorComponent"]>>[0]
>;
type Editor = ReturnType<EditorFactory>;
type Owner = {
	sessionId: string;
	ctx: ExtensionContext;
	previousEditorFactory?: EditorFactory | undefined;
	installedEditorFactory: EditorFactory;
	requestRender?: () => void;
	tui?: TUI;
	previousHardwareCursor?: boolean;
	usage?: StatusbarContextUsage | undefined;
	awaitingAssistantUsage: boolean;
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

function createExtensionStatusFooter(
	tui: TUI,
	footerData: ReadonlyFooterDataProvider,
	getTheme: () => Theme,
): Component & { dispose(): void } {
	let frame = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let mcpRatio: string | undefined;
	const stop = (): void => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	return {
		render(width: number): string[] {
			const display = formatFooterStatuses(
				footerData.getExtensionStatuses(),
				RECEIVING_SPINNER_FRAMES[frame] ?? RECEIVING_SPINNER_FRAMES[0],
				mcpRatio,
			);
			mcpRatio = display.mcpRatio;
			if (display.receiving && timer === undefined) {
				timer = setInterval(() => {
					frame = (frame + 1) % RECEIVING_SPINNER_FRAMES.length;
					tui.requestRender();
				}, 80);
			} else if (!display.receiving) stop();
			return renderExtensionStatusFooter(width, display.values, getTheme());
		},
		invalidate: () => undefined,
		dispose: stop,
	};
}

function renderTerminalCursor(lines: readonly string[]): string[] {
	const cursor = new RegExp(`${CURSOR_MARKER}\\x1b\\[7m([\\s\\S]*?)\\x1b\\[0m`, "g");
	return lines.map((line) => line.replace(cursor, `${CURSOR_MARKER}$1`));
}

export function createStatusbarFeature(
	pi: ExtensionAPI,
	getCursorOptions: () => CursorOptions = () => ({ shape: "block", blink: false }),
): StatusbarFeature {
	let owner: Owner | undefined;
	const ownsContext = (eventCtx: ExtensionContext | undefined): boolean =>
		owner !== undefined &&
		(eventCtx === undefined || eventCtx.sessionManager.getSessionId() === owner.sessionId);
	const invalidate = (_event?: unknown, eventCtx?: ExtensionContext) => {
		if (ownsContext(eventCtx)) owner?.requestRender?.();
	};
	for (const event of ["model_select", "thinking_level_select", "session_info_changed"] as const)
		pi.on(event as never, invalidate);
	pi.on("message_start", (event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined || event.message.role !== "user") return;
		owner.awaitingAssistantUsage = true;
		owner.requestRender?.();
	});
	pi.on("turn_start", (_event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		owner.awaitingAssistantUsage = true;
		owner.requestRender?.();
	});
	pi.on("message_end", (event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		if (
			event.message.role === "assistant" &&
			event.message.stopReason !== "error" &&
			event.message.stopReason !== "aborted"
		)
			owner.awaitingAssistantUsage = false;
		owner.requestRender?.();
	});
	pi.on("agent_settled", (_event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		owner.awaitingAssistantUsage = false;
		owner.requestRender?.();
	});
	pi.on("session_tree", (_event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		owner.usage = undefined;
		owner.awaitingAssistantUsage = false;
		owner.requestRender?.();
	});
	pi.on("session_compact", (_event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
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
				const active = next;
				if (
					active !== undefined &&
					active.tui === undefined &&
					typeof tui.setShowHardwareCursor === "function"
				) {
					active.tui = tui;
					active.previousHardwareCursor = tui.getShowHardwareCursor();
					tui.setShowHardwareCursor(true);
				}
				const originalRender = editor.render.bind(editor);
				(editor as Editor & { render: (width: number) => string[] }).render = (width: number) => {
					if (
						typeof tui.getShowHardwareCursor === "function" &&
						typeof tui.setShowHardwareCursor === "function" &&
						!tui.getShowHardwareCursor()
					)
						tui.setShowHardwareCursor(true);
					const lines = renderTerminalCursor(originalRender(width));
					if (tui.terminal?.write) tui.terminal.write(cursorEscape(getCursorOptions()));
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
						next.awaitingAssistantUsage,
					);
					if (usage?.tokens != null) {
						next.usage = usage;
						next.compacted = false;
					}
					return [
						renderStatusbarLine(
							width,
							buildStatusbarSnapshot({
								...(ctx.model ? { model: { name: ctx.model.name, id: ctx.model.id } } : {}),
								thinkingLevel: pi.getThinkingLevel(),
								...(usage === undefined ? {} : { usage }),
								...(systemPrompt === undefined ? {} : { systemPrompt }),
								...(sessionName === undefined ? {} : { sessionName }),
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
				awaitingAssistantUsage: false,
				compacted: false,
				previousEditorFactory,
				installedEditorFactory,
				dispose() {
					const current = next;
					if (current === undefined || owner !== current) return;
					owner = undefined;
					if (current.tui) {
						current.tui.terminal.write("\x1b[0 q");
						if (current.previousHardwareCursor !== undefined)
							current.tui.setShowHardwareCursor(current.previousHardwareCursor);
					}
					if (ctx.ui.getEditorComponent() === installedEditorFactory)
						ctx.ui.setEditorComponent(previousEditorFactory);
					ctx.ui.setFooter(undefined);
				},
			};
			owner = next;
			ctx.ui.setFooter((tui: TUI, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
				if (!next || owner !== next) return emptyFooter();
				next.requestRender = () => tui.requestRender();
				return createExtensionStatusFooter(tui, footerData, () => ctx.ui.theme);
			});
			ctx.ui.setEditorComponent(installedEditorFactory);
		},
		dispose(sessionId) {
			if (owner?.sessionId === sessionId) owner.dispose();
		},
	};
}
