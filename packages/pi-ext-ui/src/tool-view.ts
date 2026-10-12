import {
	copyToClipboard as copyToSystemClipboard,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export type FoldLevel = 0 | 1 | 2;

export type ToolStatusKind = "streaming" | "running" | "ok" | "warn" | "error" | "none";

export type RailColorToken = "muted" | "dim" | "accent" | "success" | "warning" | "error";

export interface RailSection {
	readonly railToken: RailColorToken;
	readonly content: string | readonly string[] | Component;
	readonly maxLines?: number | undefined;
}

export interface ToolViewHeaderSpec {
	readonly title: string;
	readonly status?: ToolStatusKind | undefined;
	readonly summary?: string | undefined;
	readonly unstyledSummary?: boolean | undefined;
}

export interface ToolViewCopySpec {
	readonly primary: string;
	readonly full?: string | undefined;
}

/** Micro-contract for child views that can reset their internal expansion. */
export interface Collapsible {
	collapseAll(): void;
}

export function isCollapsible(value: unknown): value is Collapsible {
	return (
		typeof value === "object" &&
		value !== null &&
		"collapseAll" in value &&
		typeof (value as Collapsible).collapseAll === "function"
	);
}

export interface ToolViewSpec {
	readonly theme: Theme;
	readonly header: ToolViewHeaderSpec;
	readonly collapsedRows?: readonly string[] | Component | (Component & Collapsible) | undefined;
	readonly sections?: readonly RailSection[] | undefined;
	readonly collapsibleChildren?: readonly Collapsible[] | undefined;
	readonly copy?: ToolViewCopySpec | undefined;
	readonly stateHolder?: unknown;
	readonly outputPad?: number | undefined;
	readonly defaultLevel?: FoldLevel | undefined;
	readonly controlledLevel?: FoldLevel | undefined;
	readonly globalExpanded?: boolean | undefined;
	readonly invalidate?: (() => void) | undefined;
	readonly copyToClipboard?: ((text: string) => Promise<void>) | undefined;
	readonly copyFeedbackDurationMs?: number | undefined;
	readonly noRail?: boolean | undefined;
	readonly railToken?: RailColorToken | undefined;
}

/** Public composition entry point for extensions that need the shared view behavior. */
export function createToolView(spec: ToolViewSpec): ToolView {
	return new ToolView(spec);
}

const FOLD_LEVEL_STATE_KEY = "__piExtUiFoldLevel";
const COPIED_UNTIL_STATE_KEY = "__piExtUiCopiedUntil";
const COPY_FEEDBACK_TIMER_KEY = "__piExtUiCopyTimer";
const DEFAULT_MAX_SECTION_LINES = 9;
const DEFAULT_COPY_FEEDBACK_MS = 1200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function transitionFoldLevel(current: FoldLevel, ctrlKey: boolean): FoldLevel {
	if (current === 0) {
		return ctrlKey ? 2 : 1;
	}
	if (current === 1) {
		return ctrlKey ? 2 : 0;
	}
	return 0;
}

function readFoldLevel(stateHolder: unknown, fallback: FoldLevel): FoldLevel {
	if (!isRecord(stateHolder)) return fallback;
	const raw = stateHolder[FOLD_LEVEL_STATE_KEY];
	return raw === 0 || raw === 1 || raw === 2 ? raw : fallback;
}

function writeFoldLevel(stateHolder: unknown, level: FoldLevel): void {
	if (!isRecord(stateHolder)) return;
	stateHolder[FOLD_LEVEL_STATE_KEY] = level;
}

function isCopiedActive(stateHolder: unknown, localCopiedUntil: number): boolean {
	const now = Date.now();
	if (localCopiedUntil > now) return true;
	if (!isRecord(stateHolder)) return false;
	const until = stateHolder[COPIED_UNTIL_STATE_KEY];
	return typeof until === "number" && until > now;
}

export function formatStatusGlyph(status: ToolStatusKind | undefined, theme: Theme): string {
	switch (status ?? "ok") {
		case "streaming":
			return theme.fg("muted", "⋯");
		case "running":
			return theme.fg("accent", "◐");
		case "ok":
			return theme.fg("success", "✓");
		case "warn":
			return theme.fg("warning", "!");
		case "error":
			return theme.fg("error", "✗");
		case "none":
			return "";
	}
}

/**
 * The glyph, name, and summary of one tool execution, colored the way every tool row colors them.
 *
 * A container tool draws one of these per child call, and so does the row of a tool that ran on its
 * own. Both must agree, so the token assignment lives here rather than in each board: a board that
 * assembled its own row painted the child's summary as a title, which read as one bright run and
 * made a nested call look unlike the same call at top level. The caller owns the fold pin, the
 * right-aligned action, and the width budget, which are the parts that actually differ.
 */
export function formatToolHeaderText(
	parts: {
		readonly status?: ToolStatusKind | undefined;
		readonly title: string;
		readonly summary?: string | undefined;
		readonly unstyledSummary?: boolean | undefined;
	},
	theme: Theme,
): string {
	const statusPart = formatStatusGlyph(parts.status, theme);
	const title = toSingleRow(parts.title);
	const titlePart = theme.fg("toolTitle", theme.bold(title));
	const summaryRaw = parts.summary === undefined ? "" : toSingleRow(parts.summary);
	const isUnstyled = parts.unstyledSummary === true || title === "bash";
	const summaryPart =
		summaryRaw === "" ? "" : isUnstyled ? ` ${summaryRaw}` : ` ${theme.fg("dim", summaryRaw)}`;
	return `${statusPart === "" ? "" : `${statusPart} `}${titlePart}${summaryPart}`;
}

const truncate = (text: string, width: number): string => truncateToWidth(text, width, "…");

/**
 * Collapses text that must occupy one row: header titles and summaries, board rows, and inline
 * labels. A break inside one of them is a contract violation, because Pi writes one array element
 * as one terminal row: `\n` moves to the next row without clearing it, and a lone `\r` returns to
 * column 0 so later text overwrites the row's start. `visibleWidth` counts both as zero-width, so
 * the host's per-row width guard cannot catch either, and the frame would silently grow taller
 * than the rows it reports.
 */
export function toSingleRow(text: string): string {
	if (!text.includes("\r") && !text.includes("\n") && !text.includes("\t")) {
		return text.trim();
	}
	return text.replace(/[\r\n\t]+/g, " ").trim();
}

/**
 * Splits multi-line content into rows. A lone `\r` is dropped rather than treated as a break so
 * CRLF and progress-style output stay cell-safe, and tabs expand to two spaces so indentation does
 * not depend on the terminal's tab stops.
 */
export function toContentRows(text: string): readonly string[] {
	if (!text.includes("\r") && !text.includes("\t") && !text.includes("\n")) {
		return [text];
	}
	return text.replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
}

/**
 * Resolves a row source into rows that are safe to hand to the host. A string element is one
 * caller-provided label, so `normalize` decides whether it stays a single row or becomes several. A
 * component returns rows it already laid out, so only its breaks are removed and its indentation is
 * preserved.
 */
function resolveRows(
	source: string | readonly string[] | Component,
	width: number,
	normalize: (text: string) => readonly string[],
): readonly string[] {
	if (typeof source === "string") {
		return source === "" ? [] : normalize(source);
	}
	if (Array.isArray(source)) {
		return source.flatMap((item) => (typeof item === "string" ? normalize(item) : []));
	}
	return (source as Component).render(width).flatMap((row) => toContentRows(row));
}

export class ToolView implements Component {
	readonly #spec: ToolViewSpec;
	#localLevel: FoldLevel;
	#localCopiedUntil = 0;
	#localTimer: ReturnType<typeof setTimeout> | undefined;
	#lastWidth = 80;
	#lastHeight = 0;
	#cache:
		| {
				readonly width: number;
				readonly level: FoldLevel;
				readonly copied: boolean;
				readonly lines: string[];
		  }
		| undefined;

	constructor(spec: ToolViewSpec) {
		this.#spec = spec;
		const initial = spec.controlledLevel ?? spec.defaultLevel ?? 0;
		this.#localLevel =
			spec.controlledLevel !== undefined
				? spec.controlledLevel
				: readFoldLevel(spec.stateHolder, initial);

		if (isRecord(spec.stateHolder)) {
			const until = spec.stateHolder[COPIED_UNTIL_STATE_KEY];
			if (typeof until === "number" && until > Date.now()) {
				this.#localCopiedUntil = until;
				const remaining = until - Date.now();
				if (!spec.stateHolder[COPY_FEEDBACK_TIMER_KEY]) {
					const timer = setTimeout(() => {
						this.#localCopiedUntil = 0;
						if (isRecord(this.#spec.stateHolder)) {
							this.#spec.stateHolder[COPIED_UNTIL_STATE_KEY] = 0;
							this.#spec.stateHolder[COPY_FEEDBACK_TIMER_KEY] = undefined;
						}
						this.#localTimer = undefined;
						this.#cache = undefined;
						this.#spec.invalidate?.();
					}, remaining);
					timer.unref?.();
					this.#localTimer = timer;
					spec.stateHolder[COPY_FEEDBACK_TIMER_KEY] = timer;
				}
			}
		}
	}

	get foldLevel(): FoldLevel {
		if (this.#spec.controlledLevel !== undefined) {
			return this.#spec.controlledLevel;
		}
		return readFoldLevel(this.#spec.stateHolder, this.#localLevel);
	}

	get effectiveLevel(): FoldLevel {
		const base = this.foldLevel;
		if (base === 0) return 0;
		if (this.#spec.globalExpanded === true) return 2;
		return base;
	}

	get collapsed(): boolean {
		return this.foldLevel === 0;
	}

	#collapseChildren(): void {
		const { collapsedRows, collapsibleChildren } = this.#spec;
		if (collapsibleChildren !== undefined) {
			for (const child of collapsibleChildren) {
				child.collapseAll();
			}
		}
		if (isCollapsible(collapsedRows)) {
			collapsedRows.collapseAll();
		}
	}

	setFoldLevel(next: FoldLevel): void {
		const prev = this.foldLevel;
		this.#localLevel = next;
		if (this.#spec.controlledLevel === undefined) {
			writeFoldLevel(this.#spec.stateHolder, next);
		}
		if (prev !== next) {
			this.#cache = undefined;
			this.#collapseChildren();
			this.#spec.invalidate?.();
		}
	}

	setCollapsed(collapsed: boolean): void {
		this.setFoldLevel(collapsed ? 0 : 1);
	}

	toggle(ctrlKey = false): void {
		this.setFoldLevel(transitionFoldLevel(this.foldLevel, ctrlKey));
	}

	#triggerCopy(shiftKey: boolean): void {
		const copySpec = this.#spec.copy;
		if (copySpec === undefined) return;
		const payload =
			shiftKey && copySpec.full !== undefined && copySpec.full !== ""
				? copySpec.full
				: copySpec.primary;
		const writeClip = this.#spec.copyToClipboard ?? copyToSystemClipboard;
		const durationMs = this.#spec.copyFeedbackDurationMs ?? DEFAULT_COPY_FEEDBACK_MS;
		const until = Date.now() + durationMs;
		this.#localCopiedUntil = until;

		if (isRecord(this.#spec.stateHolder)) {
			const prevTimer = this.#spec.stateHolder[COPY_FEEDBACK_TIMER_KEY];
			if (prevTimer !== undefined) {
				clearTimeout(prevTimer as ReturnType<typeof setTimeout>);
			}
			this.#spec.stateHolder[COPIED_UNTIL_STATE_KEY] = until;
		}
		if (this.#localTimer !== undefined) {
			clearTimeout(this.#localTimer);
		}

		void writeClip(payload).catch(() => {});
		this.#spec.invalidate?.();

		const timer = setTimeout(() => {
			this.#localCopiedUntil = 0;
			if (isRecord(this.#spec.stateHolder)) {
				this.#spec.stateHolder[COPIED_UNTIL_STATE_KEY] = 0;
				this.#spec.stateHolder[COPY_FEEDBACK_TIMER_KEY] = undefined;
			}
			this.#localTimer = undefined;
			this.#cache = undefined;
			this.#spec.invalidate?.();
		}, durationMs);
		timer.unref?.();
		this.#localTimer = timer;
		if (isRecord(this.#spec.stateHolder)) {
			this.#spec.stateHolder[COPY_FEEDBACK_TIMER_KEY] = timer;
		}
	}

	#renderHeader(width: number, level: FoldLevel): string {
		const { theme, header, copy } = this.#spec;
		const safeWidth = Math.max(1, width);
		const pinGlyph = level === 0 ? "▸" : "▾";
		const pin = theme.fg("dim", pinGlyph);
		const leftContent = `${pin} ${formatToolHeaderText(header, theme)}`;

		if (copy === undefined || safeWidth < 6) {
			return truncate(leftContent, safeWidth);
		}

		const copied = isCopiedActive(this.#spec.stateHolder, this.#localCopiedUntil);
		const copyIcon = copied ? theme.fg("success", "✓") : theme.fg("dim", "󰆏");
		// Leave 1 column on the right for Pi's fullscreen scrollbar so the copy icon doesn't collide
		const rightMargin = 1;
		const copySlotWidth = 2 + rightMargin;
		const maxLeftWidth = Math.max(1, safeWidth - copySlotWidth);
		const truncatedLeft = truncate(leftContent, maxLeftWidth);
		const leftVis = visibleWidth(truncatedLeft);
		const gap = " ".repeat(Math.max(1, safeWidth - leftVis - rightMargin - 1));
		return truncate(truncatedLeft + gap + copyIcon + " ".repeat(rightMargin), safeWidth);
	}

	#hidden = false;

	/** The result renderer of the same tool execution hides this row in place. */
	hide(): void {
		this.#hidden = true;
		this.#cache = undefined;
	}

	/**
	 * Renders only the interior content of the view without the header row.
	 * When `noRail: true` is specified, outer rail glyphs are omitted, allowing
	 * clean embedding inside composite parent components without regex text scraping.
	 */
	renderBody(width: number, options?: { noRail?: boolean }): string[] {
		if (this.#hidden) return [];
		const pad = Math.max(0, this.#spec.outputPad ?? 0);
		const safeWidth = Math.max(1, width - pad * 2);
		const level = this.effectiveLevel;
		const { theme, collapsedRows, sections } = this.#spec;
		const noRail = options?.noRail ?? this.#spec.noRail ?? false;
		const innerWidth = noRail ? safeWidth : Math.max(1, safeWidth - 2);
		const output: string[] = [];

		if (level === 0) {
			if (collapsedRows !== undefined) {
				const railColor: RailColorToken = this.#spec.header.status === "error" ? "error" : "dim";
				const rail = noRail ? "" : `${theme.fg(railColor, "▎")} `;
				const rows = resolveRows(collapsedRows, innerWidth, (row) => [toSingleRow(row)]);
				for (const row of rows) {
					output.push(truncate(rail + row, safeWidth));
				}
			}
			return output;
		}

		if (sections === undefined || sections.length === 0) {
			return output;
		}

		for (const section of sections) {
			const rail = noRail ? "" : `${theme.fg(section.railToken, "▎")} `;
			const rawLines = resolveRows(section.content, innerWidth, toContentRows);
			const cap =
				level === 1 ? (section.maxLines ?? DEFAULT_MAX_SECTION_LINES) : Number.POSITIVE_INFINITY;
			const visibleLines =
				Number.isFinite(cap) && rawLines.length > cap ? rawLines.slice(0, cap) : rawLines;
			const omittedCount = rawLines.length - visibleLines.length;

			for (const line of visibleLines) {
				output.push(truncate(rail + line, safeWidth));
			}
			if (omittedCount > 0) {
				const hint = theme.fg("dim", `… (${String(omittedCount)} more lines)`);
				output.push(truncate(rail + hint, safeWidth));
			}
		}

		return output;
	}

	render(width: number): string[] {
		if (this.#hidden) return [];
		const level = this.effectiveLevel;
		const copied = isCopiedActive(this.#spec.stateHolder, this.#localCopiedUntil);
		if (
			this.#cache !== undefined &&
			this.#cache.width === width &&
			this.#cache.level === level &&
			this.#cache.copied === copied
		) {
			return this.#cache.lines;
		}

		const pad = Math.max(0, this.#spec.outputPad ?? 0);
		const safeWidth = Math.max(1, width - pad * 2);
		this.#lastWidth = width;
		if (level !== 0) {
			this.#collapseChildren();
		}

		const rawLines = [this.#renderHeader(safeWidth, level), ...this.renderBody(width)];
		const safeLines: string[] = [];
		const leftPad = pad > 0 ? " ".repeat(pad) : "";
		for (const rawLine of rawLines) {
			if (rawLine.includes("\r") || rawLine.includes("\n")) {
				for (const line of toContentRows(rawLine)) {
					const truncated = truncate(line, safeWidth);
					safeLines.push(leftPad !== "" ? `${leftPad}${truncated}` : truncated);
				}
			} else {
				safeLines.push(leftPad !== "" ? `${leftPad}${rawLine}` : rawLine);
			}
		}
		this.#lastHeight = safeLines.length;
		this.#cache = { width, level, copied, lines: safeLines };
		return safeLines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" || this.#hidden) {
			return undefined;
		}
		if (event.type !== "click" || event.button !== "left") {
			return undefined;
		}

		const effectiveWidth = event.width > 0 ? event.width : this.#lastWidth;
		const pad = Math.max(0, this.#spec.outputPad ?? 0);
		const innerX = event.x - pad;
		const innerWidth = Math.max(1, effectiveWidth - pad * 2);
		if (innerX < 0 || innerX >= innerWidth) {
			return undefined;
		}
		// The last render's row count bounds the clickable area; a view that has not rendered yet has no
		// extent to test against, and Pi always renders before it dispatches a mouse event.
		if (this.#lastHeight > 0 && (event.y < 0 || event.y >= this.#lastHeight)) {
			return undefined;
		}

		if (event.y === 0) {
			if (
				this.#spec.copy !== undefined &&
				innerWidth >= 6 &&
				innerX >= innerWidth - 3 &&
				innerX < innerWidth
			) {
				this.#triggerCopy(event.shift === true);
				return { handled: true, render: true };
			}

			this.toggle(event.ctrl === true);
			return { handled: true, render: true };
		}

		const level = this.effectiveLevel;
		if (level === 0 && this.#spec.collapsedRows !== undefined) {
			const rows = this.#spec.collapsedRows;
			if (
				typeof rows === "object" &&
				rows !== null &&
				"handleMouse" in rows &&
				typeof (rows as { handleMouse?: unknown }).handleMouse === "function"
			) {
				const handler = (
					rows as { handleMouse: (e: TuiMouseEvent) => TuiMouseEventResult | undefined }
				).handleMouse;
				const railOffset = this.#spec.noRail ? 0 : 2;
				const subEvent: TuiMouseEvent = {
					...event,
					y: event.y - 1,
					x: Math.max(0, innerX - railOffset),
					width: Math.max(1, innerWidth - railOffset),
				};
				const res = handler.call(rows, subEvent);
				if (res?.handled) {
					this.#cache = undefined;
					return res;
				}
			}
		}

		return { handled: true };
	}

	invalidate(): void {
		this.#cache = undefined;
		const { collapsedRows, sections } = this.#spec;
		if (
			collapsedRows !== undefined &&
			typeof collapsedRows === "object" &&
			"invalidate" in collapsedRows
		) {
			collapsedRows.invalidate();
		}
		if (sections !== undefined) {
			for (const section of sections) {
				if (typeof section.content === "object" && "invalidate" in section.content) {
					section.content.invalidate();
				}
			}
		}
	}
}
