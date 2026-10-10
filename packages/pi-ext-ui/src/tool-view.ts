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

function formatStatusGlyph(status: ToolStatusKind | undefined, theme: Theme): string {
	switch (status ?? "ok") {
		case "streaming":
			return `${theme.fg("muted", "⋯")} `;
		case "running":
			return `${theme.fg("accent", "◐")} `;
		case "ok":
			return `${theme.fg("success", "✓")} `;
		case "warn":
			return `${theme.fg("warning", "!")} `;
		case "error":
			return `${theme.fg("error", "✗")} `;
		case "none":
			return "";
	}
}

const truncate = (text: string, width: number): string => truncateToWidth(text, width, "…");

function resolveLines(
	source: string | readonly string[] | Component,
	width: number,
): readonly string[] {
	if (typeof source === "string") {
		return source === "" ? [] : source.replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
	}
	if (Array.isArray(source)) {
		return source.flatMap((item) =>
			typeof item === "string" ? item.replace(/\r/g, "").replace(/\t/g, "  ").split("\n") : [],
		);
	}
	return (source as Component).render(width);
}

export class ToolView implements Component {
	readonly #spec: ToolViewSpec;
	#localLevel: FoldLevel;
	#localCopiedUntil = 0;
	#localTimer: ReturnType<typeof setTimeout> | undefined;
	#lastWidth = 80;

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
		const statusPart = formatStatusGlyph(header.status, theme);
		const titlePart = theme.fg("toolTitle", theme.bold(header.title));
		const summaryRaw = header.summary?.trim() ?? "";
		const isUnstyled = header.unstyledSummary === true || header.title === "bash";
		const summaryPart =
			summaryRaw === "" ? "" : isUnstyled ? ` ${summaryRaw}` : ` ${theme.fg("dim", summaryRaw)}`;
		const leftContent = `${pin} ${statusPart}${titlePart}${summaryPart}`;

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
				const rows = resolveLines(collapsedRows, innerWidth);
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
			const rawLines = resolveLines(section.content, innerWidth);
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
		const pad = Math.max(0, this.#spec.outputPad ?? 0);
		const safeWidth = Math.max(1, width - pad * 2);
		this.#lastWidth = width;
		const level = this.effectiveLevel;
		if (level !== 0) {
			this.#collapseChildren();
		}

		const header = this.#renderHeader(safeWidth, level);
		const body = this.renderBody(width);
		const allLines = [header, ...body];

		if (pad > 0) {
			const leftPad = " ".repeat(pad);
			return allLines.map((line) => `${leftPad}${line}`);
		}
		return allLines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
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
				if (res?.handled) return res;
			}
		}

		return undefined;
	}

	invalidate(): void {
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
