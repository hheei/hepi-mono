import {
	buildSessionContext,
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";
import type { HepiRuntimeContext } from "../../runtime/context.js";
import { type CursorOptions, cursorEscape } from "./cursor.js";
import {
	advisorIndicatorFromStatuses,
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
type StatusbarSession = {
	readonly sessionId: string;
	footerData?: ReadonlyFooterDataProvider;
	requestRender?: () => void;
	renderScheduled: boolean;
	tui?: TUI;
	previousHardwareCursor?: boolean;
	usage?: StatusbarContextUsage | undefined;
	awaitingAssistantUsage: boolean;
	compacted: boolean;
};

export interface StatusbarFeature {
	start(runtime: HepiRuntimeContext): void;
	dispose(sessionId: string): void;
}

function emptyFooter(): Component {
	return { render: () => [], invalidate: () => undefined };
}

function createExtensionStatusFooter(
	footerData: ReadonlyFooterDataProvider,
	getTheme: () => Theme,
	requestRender: () => void,
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
					requestRender();
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
	let owner: StatusbarSession | undefined;
	const disposeSession = (sessionId: string): void => {
		const current = owner;
		if (current?.sessionId !== sessionId) return;
		owner = undefined;
		if (!current.tui) return;
		current.tui.terminal.write("\x1b[0 q");
		if (current.previousHardwareCursor !== undefined)
			current.tui.setShowHardwareCursor(current.previousHardwareCursor);
	};
	const scheduleRender = (current: StatusbarSession): void => {
		if (owner !== current) return;
		if (current.renderScheduled) return;
		current.renderScheduled = true;
		current.requestRender?.();
		queueMicrotask(() => {
			current.renderScheduled = false;
		});
	};
	const setAwaitingAssistantUsage = (current: StatusbarSession, value: boolean): void => {
		if (current.awaitingAssistantUsage === value) return;
		current.awaitingAssistantUsage = value;
		scheduleRender(current);
	};
	const ownsContext = (eventCtx: ExtensionContext | undefined): boolean =>
		owner !== undefined &&
		(eventCtx === undefined || eventCtx.sessionManager.getSessionId() === owner.sessionId);
	const invalidate = (_event?: unknown, eventCtx?: ExtensionContext) => {
		if (ownsContext(eventCtx) && owner !== undefined) scheduleRender(owner);
	};
	for (const event of ["model_select", "thinking_level_select", "session_info_changed"] as const)
		pi.on(event as never, invalidate);
	pi.on("message_start", (event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined || event.message.role !== "user") return;
		setAwaitingAssistantUsage(owner, true);
	});
	pi.on("turn_start", (_event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		setAwaitingAssistantUsage(owner, true);
	});
	pi.on("message_end", (event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		if (
			event.message.role === "assistant" &&
			event.message.stopReason !== "error" &&
			event.message.stopReason !== "aborted"
		)
			setAwaitingAssistantUsage(owner, false);
	});
	pi.on("agent_settled", (_event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		setAwaitingAssistantUsage(owner, false);
	});
	pi.on("session_tree", (_event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		owner.usage = undefined;
		owner.awaitingAssistantUsage = false;
		scheduleRender(owner);
	});
	pi.on("session_compact", (_event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		owner.usage = undefined;
		owner.compacted = true;
		scheduleRender(owner);
	});
	return {
		start(runtime) {
			const ctx = runtime.ctx;
			const sessionId = ctx.sessionManager.getSessionId();
			if (owner?.sessionId === sessionId) return;
			if (owner !== undefined) disposeSession(owner.sessionId);
			if (
				ctx.mode !== "tui" ||
				typeof ctx.ui.getEditorComponent !== "function" ||
				typeof ctx.ui.setEditorComponent !== "function" ||
				typeof ctx.ui.setFooter !== "function"
			)
				return;
			const previousEditorFactory = ctx.ui.getEditorComponent();
			let session: StatusbarSession | undefined;
			const installedEditorFactory = ((tui, theme, keybindings) => {
				const editor =
					previousEditorFactory?.(tui, theme, keybindings) ??
					new CustomEditor(tui, theme, keybindings);
				const active = session;
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
				let cursorWriteScheduled = false;
				(editor as Editor & { render: (width: number) => string[] }).render = (width: number) => {
					if (
						typeof tui.getShowHardwareCursor === "function" &&
						typeof tui.setShowHardwareCursor === "function" &&
						!tui.getShowHardwareCursor()
					)
						tui.setShowHardwareCursor(true);
					const lines = renderTerminalCursor(originalRender(width));
					if (tui.terminal?.write && !cursorWriteScheduled) {
						cursorWriteScheduled = true;
						queueMicrotask(() => {
							cursorWriteScheduled = false;
							if (session && owner === session)
								tui.terminal?.write(cursorEscape(getCursorOptions()));
						});
					}
					if (!lines.length || !session || owner !== session) return lines;
					const systemPrompt =
						typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined;
					const currentUsage = ctx.getContextUsage();
					let fallback: StatusbarContextUsage | undefined;
					if (currentUsage?.tokens == null || session.compacted) {
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
						session.compacted ? undefined : session.usage,
						fallback,
						session.awaitingAssistantUsage,
					);
					const advisorIndicator = advisorIndicatorFromStatuses(
						session.footerData?.getExtensionStatuses(),
					);
					if (usage?.tokens != null) {
						session.usage = usage;
						session.compacted = false;
					}
					return [
						renderStatusbarLine(
							width,
							buildStatusbarSnapshot({
								...(ctx.model ? { model: { name: ctx.model.name, id: ctx.model.id } } : {}),
								thinkingLevel: pi.getThinkingLevel(),
								...(advisorIndicator === undefined ? {} : { advisorIndicator }),
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
			session = {
				sessionId,
				awaitingAssistantUsage: false,
				compacted: false,
				renderScheduled: false,
			};
			owner = session;
			ctx.ui.setFooter((tui: TUI, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
				if (!session || owner !== session) return emptyFooter();
				session.footerData = footerData;
				session.requestRender = () => tui.requestRender();
				return createExtensionStatusFooter(
					footerData,
					() => ctx.ui.theme,
					() => scheduleRender(session),
				);
			});
			ctx.ui.setEditorComponent(installedEditorFactory);
		},
		dispose(sessionId) {
			disposeSession(sessionId);
		},
	};
}
