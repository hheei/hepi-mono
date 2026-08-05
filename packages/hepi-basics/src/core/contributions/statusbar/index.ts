import {
	buildSessionContext,
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";
import type { HepiRuntimeContext } from "../../runtime/context.js";
import { fmtCompactNumber } from "../../ui/number.js";
import { type CursorOptions, cursorEscape } from "./cursor.js";
import {
	advisorIndicatorFromStatuses,
	autoTitleStatus,
	contextMeter,
	estimateContextUsage,
	formatFooterStatuses,
	normalizeDisplayFragment,
	type StatusbarContextUsage,
	type StatusbarSnapshot,
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
	fallbackUsage?: StatusbarContextUsage | undefined;
	awaitingAssistantUsage: boolean;
	compacted: boolean;
	staticUsage?: {
		readonly activeToolsKey: string;
		readonly systemPrompt: string;
		readonly tokens: number;
	};
};

const TERMINAL_CURSOR_PATTERN = new RegExp(`${CURSOR_MARKER}\\x1b\\[7m([\\s\\S]*?)\\x1b\\[0m`, "g");

export interface StatusbarFeature {
	start(runtime: HepiRuntimeContext): void;
	dispose(sessionId: string): void;
}

function emptyFooter(): Component {
	return { render: () => [], invalidate: () => undefined };
}

function createExtensionStatusFooter(
	workingDirectory: string,
	footerData: ReadonlyFooterDataProvider,
	getTheme: () => Theme,
): Component {
	let mcpRatio: string | undefined;
	return {
		render(width: number): string[] {
			const display = formatFooterStatuses(footerData.getExtensionStatuses(), mcpRatio);
			mcpRatio = display.mcpRatio;
			return renderExtensionStatusFooter(
				width,
				[getTheme().fg("dim", workingDirectory), ...display.values],
				getTheme(),
			);
		},
		invalidate: () => undefined,
	};
}

function renderTerminalCursor(lines: readonly string[]): string[] {
	return lines.map((line) => line.replace(TERMINAL_CURSOR_PATTERN, `${CURSOR_MARKER}$1`));
}

export function createStatusbarFeature(
	pi: ExtensionAPI,
	getCursorOptions: () => CursorOptions = () => ({ shape: "block", blink: false }),
): StatusbarFeature {
	let owner: StatusbarSession | undefined;
	const activeToolDefinitions = (activeToolNames: readonly string[]): readonly unknown[] => {
		const activeTools = new Set(activeToolNames);
		return pi
			.getAllTools()
			.filter((tool) => activeTools.has(tool.name))
			.map(({ name, description, parameters }) => ({ name, description, parameters }));
	};
	const staticContextTokens = (
		session: StatusbarSession,
		systemPrompt: string,
		contextWindow: number | null | undefined,
	): number => {
		const activeToolNames = [...pi.getActiveTools()].sort();
		const activeToolsKey = activeToolNames.join("\u0000");
		const cached = session.staticUsage;
		if (cached?.systemPrompt === systemPrompt && cached.activeToolsKey === activeToolsKey)
			return cached.tokens;
		const tokens =
			estimateContextUsage([], contextWindow, systemPrompt, activeToolDefinitions(activeToolNames))
				?.tokens ?? estimateTokens({ role: "user", content: systemPrompt } as never);
		session.staticUsage = { activeToolsKey, systemPrompt, tokens };
		return tokens;
	};
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
	const invalidateFallbackUsage = (current: StatusbarSession): void => {
		current.fallbackUsage = undefined;
	};
	const ownsContext = (eventCtx: ExtensionContext | undefined): boolean =>
		owner !== undefined &&
		(eventCtx === undefined || eventCtx.sessionManager.getSessionId() === owner.sessionId);
	const invalidate = (_event?: unknown, eventCtx?: ExtensionContext) => {
		if (ownsContext(eventCtx) && owner !== undefined) {
			invalidateFallbackUsage(owner);
			scheduleRender(owner);
		}
	};
	for (const event of ["model_select", "thinking_level_select", "session_info_changed"] as const)
		pi.on(event as never, invalidate);
	pi.on("message_start", (event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined || event.message.role !== "user") return;
		setAwaitingAssistantUsage(owner, true);
	});
	pi.on("turn_start", (_event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		invalidateFallbackUsage(owner);
		setAwaitingAssistantUsage(owner, true);
	});
	pi.on("message_end", (event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		invalidateFallbackUsage(owner);
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
		invalidateFallbackUsage(owner);
		owner.awaitingAssistantUsage = false;
		scheduleRender(owner);
	});
	pi.on("session_compact", (_event, eventCtx) => {
		if (!ownsContext(eventCtx) || owner === undefined) return;
		owner.usage = undefined;
		invalidateFallbackUsage(owner);
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
				typeof ctx.ui.setEditorComponent !== "function" ||
				typeof ctx.ui.setFooter !== "function"
			)
				return;
			let session: StatusbarSession | undefined;
			const installEditorFactory = (previousEditorFactory: EditorFactory | undefined): void => {
				const nextEditorFactory = ((tui, theme, keybindings) => {
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
						if (!session || owner !== session) return lines;
						const systemPrompt =
							typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : undefined;
						const currentUsage = ctx.getContextUsage();
						let fallback: StatusbarContextUsage | undefined;
						if (currentUsage?.tokens == null || session.compacted) {
							if (session.fallbackUsage?.contextWindow === currentUsage?.contextWindow) {
								fallback = session.fallbackUsage;
							} else {
								try {
									const messages = buildSessionContext(
										ctx.sessionManager.getBranch() as never,
									).messages;
									fallback = estimateContextUsage(
										messages,
										currentUsage?.contextWindow,
										systemPrompt,
										activeToolDefinitions(pi.getActiveTools()),
									);
								} catch {
									fallback = undefined;
								}
								session.fallbackUsage = fallback;
							}
						}
						const usage = stabilizeContextUsage(
							currentUsage,
							session.compacted ? undefined : session.usage,
							fallback,
							session.awaitingAssistantUsage,
						);
						const statuses = session.footerData?.getExtensionStatuses();
						const advisorIndicator = advisorIndicatorFromStatuses(statuses);
						const titleGeneration = autoTitleStatus(statuses);
						if (usage?.tokens != null) {
							session.usage = usage;
							session.compacted = false;
						}
						let displayUsage = usage;
						if (displayUsage?.tokens === 0 && systemPrompt !== undefined) {
							const tokens = staticContextTokens(session, systemPrompt, displayUsage.contextWindow);
							const { contextWindow } = displayUsage;
							const percent =
								typeof contextWindow === "number" &&
								Number.isFinite(contextWindow) &&
								contextWindow > 0
									? (tokens / contextWindow) * 100
									: displayUsage.percent;
							displayUsage = {
								...displayUsage,
								tokens,
								...(percent === undefined ? {} : { percent }),
							};
						}
						const normalizedModelName = normalizeDisplayFragment(ctx.model?.name, "");
						const model =
							normalizedModelName !== ""
								? normalizedModelName
								: normalizeDisplayFragment(ctx.model?.id);
						const sessionName = normalizeDisplayFragment(ctx.sessionManager.getSessionName(), "");
						const thinkingLevel = pi.getThinkingLevel();
						const snapshot: StatusbarSnapshot = {
							model,
							...(advisorIndicator === undefined ? {} : { advisorIndicator }),
							thinkingLevel,
							meter: contextMeter(displayUsage?.percent),
							contextTokens: fmtCompactNumber(displayUsage?.tokens, "lower"),
							contextLimit: fmtCompactNumber(displayUsage?.contextWindow, "lower"),
							percent:
								typeof displayUsage?.percent === "number" && Number.isFinite(displayUsage.percent)
									? displayUsage.percent
									: null,
							...(sessionName ? { sessionName } : {}),
							...(titleGeneration === undefined ? {} : { titleGeneration }),
							statuses: [],
						};
						return [renderStatusbarLine(width, snapshot, ctx.ui.theme), ...lines.slice(1)];
					};
					return editor;
				}) as EditorFactory;
				ctx.ui.setEditorComponent(nextEditorFactory);
			};
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
				return createExtensionStatusFooter(ctx.cwd, footerData, () => ctx.ui.theme);
			});
			installEditorFactory(
				typeof ctx.ui.getEditorComponent === "function" ? ctx.ui.getEditorComponent() : undefined,
			);
		},
		dispose(sessionId) {
			disposeSession(sessionId);
		},
	};
}
