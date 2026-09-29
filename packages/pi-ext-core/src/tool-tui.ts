import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import { getGlobalState } from "./global-state.js";
import { isRecord } from "./record.js";
import { runtimeIdentity } from "./runtime-identity.js";
import { agentResultText, formatDuration } from "./tool-result.js";

type FrameStatus = "pending" | "success" | "warning" | "error";

type FrameHeader = {
	readonly primary: string;
	readonly suffix?: string;
};

export type ToolCompletion = {
	readonly durationMs?: number;
	readonly errorMessage?: string;
	readonly warning?: boolean;
};

/** Automatic frame collapse policy applied to tool calls marked `longOutput`. */
export type ToolCollapseMode = "auto" | "pertrace" | "off" | "on";

/** Delay between one long-output result completing and its `auto` collapse. */
export const AUTO_COLLAPSE_DELAY_MS = 15_000;

/** Retry interval when auto-collapse is postponed due to user scrolling up. */
export const AUTO_COLLAPSE_RETRY_DELAY_MS = 3_000;

export type ToolTuiPresentation<TParams extends TSchema, TDetails, TState = unknown> = {
	/**
	 * Header text after the label. An empty string means the label stands alone, which is the shape
	 * for a tool whose input is its own request body and whose header only carries call facts.
	 */
	readonly summary?: ToolFrameHeader<TParams, TDetails>;
	readonly summarySeparator?: "dot" | "space";
	/**
	 * Renders the tool's input (command, code, task text) as the frame's request body, which stays
	 * visible while arguments stream and after the result arrives. Declaring it replaces the tool's
	 * own call-phase `renderCall` body.
	 */
	readonly request?: ToolRequestRenderer<TParams, TState>;
	/**
	 * Dim parenthesized call facts appended to the header summary, such as `(reset)` or
	 * `(timeout 30s)`. Declaring it puts the header in the inline form `label (host) summary
	 * (facts)` instead of `label · summary`, matching `bash`.
	 */
	readonly suffix?: (args: Static<TParams>) => string | undefined;
	/** Paint a path summary as warning-colored `host:path` for SSH targets. */
	readonly remotePathSummary?: boolean;
	readonly footer?: (
		result: AgentToolResult<TDetails>,
		completion: ToolCompletion | undefined,
		options: ToolRenderResultOptions,
	) => string | undefined;
	readonly warning?: (result: AgentToolResult<TDetails>) => boolean;
	/** Unexpanded body rows. Default 20. Non-finite or < 1 disables the cap. */
	readonly maxBodyLines?: number;
	/**
	 * How the header and the footer summary row handle content wider than the terminal.
	 * `wrap` (default) keeps every row; `truncate` holds both to one row, at the cost of
	 * the tail of their text staying invisible. Tools whose body cannot recover that text
	 * opt into `truncate`.
	 */
	readonly headerLine?: "wrap" | "truncate";
	/**
	 * Declares a tool whose completed body is large enough to auto-collapse. Only the
	 * `auto` and `on` modes use it; the concrete extension decides which tools qualify.
	 */
	readonly longOutput?: boolean;
};

export interface ToolTui {
	beginTrace(): void;
	/** Drops every tool record and pending collapse timer of the finished session. */
	resetSession(): void;
	setToolCollapseMode(mode: ToolCollapseMode): void;
	/**
	 * Reports whether the user is reading above the end, so an automatic collapse can wait
	 * until they return to it. The active editor factory supplies it from the fullscreen
	 * viewport; with no predicate set, or one that always reports the end (regular mode),
	 * no collapse ever waits.
	 */
	setScrolledUpPredicate(predicate: (() => boolean) | undefined): void;
	frame<TParams extends TSchema, TDetails, TState>(
		tool: ToolDefinition<TParams, TDetails, TState>,
		presentation?: ToolTuiPresentation<TParams, TDetails, TState>,
	): ToolDefinition<TParams, TDetails, TState>;
}

/** The host's call-render context, derived from the definition it hands to `renderCall`. */
type ToolCallContext<TParams extends TSchema, TState> = Parameters<
	NonNullable<ToolDefinition<TParams, unknown, TState>["renderCall"]>
>[2];

/** Renders a tool's input as the frame's request body; see `ToolTuiPresentation.request`. */
export type ToolRequestRenderer<TParams extends TSchema, TState> = (
	args: Static<TParams>,
	theme: Theme,
	context: ToolCallContext<TParams, TState>,
) => Component | undefined;

type ToolFrameHeader<TParams extends TSchema, TDetails> = (
	args: Static<TParams>,
	latest: AgentToolResult<TDetails> | undefined,
	context?: { readonly state?: unknown },
) => string | undefined;

export const DEFAULT_MAX_BODY_LINES = 20;
/** Head rows a request body keeps before its dim hidden-lines hint. */
export const DEFAULT_MAX_REQUEST_LINES = 10;
const EXPAND_HINT = "ctrl+o to expand";
const COMPLETION_KEY = "__piExtToolsCompletion";

const TOOL_BACKGROUNDS: ReadonlySet<Parameters<Theme["bg"]>[0]> = new Set([
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
]);

/**
 * The frame owns the whole tool surface, so Pi's `tool*Bg` box is dropped and a prior Trace's
 * body text is dimmed. Both rules share one proxy trap chain because every renderer receives
 * the composed theme.
 */
function frameTheme(theme: Theme, historical: boolean): Theme {
	return new Proxy(theme, {
		get(target, property, receiver): unknown {
			if (property === "bg")
				return (role: Parameters<Theme["bg"]>[0], text: string): string =>
					TOOL_BACKGROUNDS.has(role) ? text : target.bg(role, text);
			if (property === "fg")
				return (role: Parameters<Theme["fg"]>[0], text: string): string =>
					role === "text" ? (historical ? target.fg("dim", text) : text) : target.fg(role, text);
			return Reflect.get(target, property, receiver);
		},
	});
}

/**
 * Pi re-renders every component on every TUI frame, while one component instance keeps its
 * width until the host replaces it. Width-derived rows are therefore computed once per width:
 * cell-width truncation of non-ASCII text walks a grapheme segmenter and costs microseconds.
 */
function memoByWidth<T>(compute: (width: number) => T): (width: number) => T {
	let cached: { readonly width: number; readonly value: T } | undefined;
	return (width: number): T => {
		if (cached === undefined || cached.width !== width) cached = { width, value: compute(width) };
		return cached.value;
	};
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function argsRecord(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : {};
}

function remoteTarget(values: Record<string, unknown>): string | undefined {
	const target = textValue(values.target);
	return target === undefined || target === "local" ? undefined : target;
}

function remoteLocation(values: Record<string, unknown>, path: string): string {
	const target = remoteTarget(values);
	return target === undefined ? path : `${target}:${path}`;
}

function paintRemotePath(
	values: Record<string, unknown>,
	path: string,
	theme: Theme,
	muted: boolean,
): string {
	const location = remoteLocation(values, path);
	const target = remoteTarget(values);
	if (muted) return theme.fg("dim", location);
	if (target === undefined) return location;
	return `${theme.fg("warning", `${target}:`)}${path}`;
}

function summaryFor(args: unknown): string {
	const values = argsRecord(args);
	const path = textValue(values.path) ?? textValue(values.file_path);
	return path === undefined ? "" : path;
}

type HeaderInput = {
	readonly tool: { readonly name: string; readonly label: string };
	readonly args: unknown;
	readonly theme: Theme;
	readonly context: { readonly isError: boolean; readonly isPartial: boolean };
	readonly warning: boolean | undefined;
	readonly summary: string | undefined;
	readonly summarySeparator: "dot" | "space";
	readonly remotePathSummary: boolean;
	readonly collapsed: boolean;
	readonly historical: boolean;
	/** Dim parenthesized call facts rendered after the header summary. */
	readonly suffix: string | undefined;
	/**
	 * Whether the header uses the inline `label input (facts)` form. Declaring `suffix` decides
	 * this once per tool, so the shape cannot flip while arguments stream.
	 */
	readonly inlineSummary: boolean;
};

function headerFor(input: HeaderInput): FrameHeader {
	const { tool, theme, collapsed, historical, summary: summaryOverride } = input;
	const status = statusPrefix(
		input.warning === true ? "warning" : input.context.isError ? "error" : statusFor(input.context),
		theme,
	);
	const values = argsRecord(input.args);
	const path = textValue(values.path);
	if (summaryOverride !== undefined) {
		const dot = input.summarySeparator === "dot" ? ` ${theme.fg("dim", "·")}` : "";
		if (input.remotePathSummary && path !== undefined) {
			return {
				primary: `${status} ${theme.fg("toolTitle", theme.bold(tool.label))}${dot} ${paintRemotePath(values, path, theme, collapsed)}`,
			};
		}
		const host = remoteTarget(values);
		const hostPaint =
			host === undefined ? undefined : theme.fg(collapsed ? "dim" : "warning", `(${host})`);
		const hostLabel = hostPaint === undefined ? "" : `${hostPaint} `;
		// An empty summary means the label stands alone; dimming it would leave an empty escape pair.
		const summary =
			collapsed && summaryOverride !== "" ? theme.fg("dim", summaryOverride) : summaryOverride;
		if (input.inlineSummary) {
			const facts = input.suffix?.trim() ?? "";
			const label = `${status} ${theme.fg("toolTitle", theme.bold(tool.label))}`;
			const head = [hostPaint, summary].filter((part) => part !== undefined && part !== "");
			return {
				primary: head.length === 0 ? label : `${label} ${head.join(" ")}`,
				...(facts === "" ? {} : { suffix: theme.fg("dim", ` ${facts}`) }),
			};
		}
		return {
			primary: `${status} ${theme.fg("toolTitle", theme.bold(tool.label))}${dot} ${hostLabel}${summary}`,
		};
	}
	const pattern = textValue(values.pattern);
	if (tool.name === "read" && path !== undefined) {
		const offset = typeof values.offset === "number" ? values.offset : undefined;
		const limit = typeof values.limit === "number" ? values.limit : undefined;
		const range =
			limit === undefined
				? offset === undefined
					? ""
					: `:${offset}`
				: `:${offset ?? 1}-${(offset ?? 1) + limit - 1}`;
		return {
			primary: `${status} ${theme.fg("toolTitle", theme.bold(tool.label))} ${paintRemotePath(values, path, theme, collapsed)}${theme.fg(collapsed ? "dim" : "warning", range)}`,
		};
	}
	if ((tool.name === "grep" || tool.name === "find") && pattern !== undefined) {
		const location =
			path === undefined
				? undefined
				: historical
					? theme.fg("dim", `in ${remoteLocation(values, path)}`)
					: `in ${paintRemotePath(values, path, theme, false)}`;
		const summary = [
			theme.fg("toolTitle", theme.bold(tool.label)),
			theme.fg("mdCode", `/${pattern}/`),
			...(location === undefined ? [] : [location]),
		].join(" ");
		return { primary: `${status} ${summary}` };
	}
	const summary = summaryFor(input.args);
	return {
		primary: [
			status,
			theme.fg("toolTitle", theme.bold(tool.label)),
			...(summary === "" ? [] : [theme.fg("dim", summary)]),
		].join(" "),
	};
}

function statusFor(context: {
	readonly isError: boolean;
	readonly isPartial: boolean;
}): FrameStatus {
	if (context.isError) return "error";
	return context.isPartial ? "pending" : "success";
}

function statusPrefix(status: FrameStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("warning", "󰪠");
		case "success":
			return theme.fg("success", "󰄴");
		case "warning":
			return theme.fg("warning", "󰀪");
		case "error":
			return theme.fg("error", "󰅚");
	}
}

function completionFrom(
	result: AgentToolResult<unknown>,
	completion: ToolCompletion | undefined,
): ToolCompletion | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return completion;
	const stored = (details as Record<string, unknown>)[COMPLETION_KEY];
	if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return completion;
	const value = stored as Record<string, unknown>;
	return {
		...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
		...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
		...(typeof value.warning === "boolean" ? { warning: value.warning } : {}),
	};
}

function withCompletion<T>(
	result: AgentToolResult<T>,
	completion: ToolCompletion,
): AgentToolResult<T> {
	const details = result.details;
	return {
		...result,
		details: (isRecord(details)
			? { ...details, [COMPLETION_KEY]: completion }
			: { [COMPLETION_KEY]: completion }) as T,
	};
}

function typedFooter(value: string | undefined): string | undefined {
	const footer = value?.trim();
	return footer === undefined || footer === "" ? undefined : footer;
}

function defaultFooter(completion: ToolCompletion | undefined, isError: boolean): string {
	const duration = formatDuration(completion?.durationMs);
	if (isError) return duration ? `error · ${duration}` : "error";
	return duration ?? "completed";
}

class ToolTraceController {
	private trace = 0;
	private mode: ToolCollapseMode = "auto";
	private readonly tools = new Map<string, ToolRecord>();
	private isScrolledUp: (() => boolean) | undefined;

	setScrolledUpPredicate(predicate: (() => boolean) | undefined): void {
		this.isScrolledUp = predicate;
	}

	setMode(mode: ToolCollapseMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		for (const tool of this.tools.values()) {
			if (tool.completion === undefined) {
				this.clearCollapseTimer(tool);
				continue;
			}
			this.scheduleCollapse(tool);
			tool.invalidate?.();
		}
	}

	/** One turn boundary: a pending timer can never outlive the trace that created it. */
	startTrace(): void {
		this.trace += 1;
		for (const tool of this.tools.values()) {
			this.clearCollapseTimer(tool);
			if (tool.trace < this.trace) tool.invalidate?.();
		}
	}

	resetSession(): void {
		for (const tool of this.tools.values()) this.clearCollapseTimer(tool);
		this.tools.clear();
	}

	begin(toolCallId: string, longOutput = false): void {
		const previous = this.tools.get(toolCallId);
		if (previous !== undefined) this.clearCollapseTimer(previous);
		this.tools.set(toolCallId, {
			trace: this.trace,
			executionStarted: true,
			startedAt: performance.now(),
			longOutput,
		});
	}

	complete(toolCallId: string, warning = false): ToolCompletion {
		const tool = this.tools.get(toolCallId);
		const completion = {
			...(tool?.startedAt === undefined
				? {}
				: { durationMs: Math.round(performance.now() - tool.startedAt) }),
			...(warning ? { warning: true } : {}),
		};
		if (tool !== undefined) {
			tool.completion = completion;
			this.scheduleCollapse(tool);
		}
		return completion;
	}

	fail(toolCallId: string, error: unknown): ToolCompletion {
		const message = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : "failed";
		const completion = { ...this.complete(toolCallId), errorMessage: message || "failed" };
		const tool = this.tools.get(toolCallId);
		if (tool !== undefined) tool.completion = completion;
		return completion;
	}

	update(toolCallId: string, result: AgentToolResult<unknown>): void {
		const tool = this.tools.get(toolCallId);
		if (tool === undefined) return;
		tool.latest = result;
		tool.invalidate?.();
	}

	restore(
		toolCallId: string | undefined,
		result: AgentToolResult<unknown>,
		completion: ToolCompletion | undefined,
	): void {
		if (toolCallId === undefined) return;
		const tool = this.tools.get(toolCallId);
		if (tool === undefined) return;
		const changed =
			!sameResult(tool.latest, result) || !sameCompletion(tool.completion, completion);
		tool.latest = result;
		if (completion === undefined) delete tool.completion;
		else tool.completion = completion;
		// `summary` presenters that read `latest` (for example apply_patch) render before this
		// call has recorded the restored result, so they need one repaint of the same row.
		if (changed) queueMicrotask(() => tool.invalidate?.());
	}

	latestFor(toolCallId: string): AgentToolResult<unknown> | undefined {
		return this.tools.get(toolCallId)?.latest;
	}

	/** Records whether the call phase drew a body, so the result does not open a second rail. */
	markRail(toolCallId: string, drawn: boolean): void {
		const tool = this.tools.get(toolCallId);
		if (tool !== undefined) tool.railDrawn = drawn;
	}

	/**
	 * True only when this row's call phase really drew the section above the result. A declared
	 * request renderer that produced nothing leaves the result to draw its own separator, and a row
	 * restored without a call phase has drawn nothing either.
	 */
	railDrawn(toolCallId: string | undefined): boolean {
		if (toolCallId === undefined) return false;
		return this.tools.get(toolCallId)?.railDrawn === true;
	}

	observe(toolCallId: string, executionStarted: boolean, invalidate: () => void): ToolRecord {
		const existing = this.tools.get(toolCallId);
		if (existing !== undefined) {
			existing.invalidate = invalidate;
			// A tool can be rendered once while its arguments are still streaming.
			// Promote that preview record when execution starts so it is not treated
			// as a prior trace after the host switches to the execution phase. The
			// promotion happens once: later traces must still be able to collapse it.
			if (executionStarted && !existing.executionStarted) {
				existing.executionStarted = true;
				if (existing.trace < this.trace) existing.trace = this.trace;
			}
			return existing;
		}
		const tool = {
			trace: executionStarted ? this.trace : -1,
			executionStarted,
			invalidate,
		};
		this.tools.set(toolCallId, tool);
		return tool;
	}

	isPriorTrace(
		toolCallId: string | undefined,
		executionStarted: boolean,
		invalidate: () => void,
	): boolean {
		if (toolCallId === undefined) return false;
		return this.observe(toolCallId, executionStarted, invalidate).trace < this.trace;
	}

	/**
	 * The one collapse decision shared by the call and result slots. An explicit
	 * expansion wins, `off` disables every automatic collapse, and otherwise the
	 * record is collapsed once its timer elapsed or a later trace started. A collapse
	 * that would shrink the transcript under a reader is postponed instead.
	 */
	isCollapsed(
		toolCallId: string | undefined,
		expanded: boolean,
		executionStarted: boolean,
		invalidate: () => void,
	): boolean {
		if (expanded || toolCallId === undefined || this.mode === "off") return false;
		const record = this.observe(toolCallId, executionStarted, invalidate);
		if (record.timerCollapsed === true) return true;
		if (record.trace >= this.trace) return false;
		return !this.postponeWhileReading(record);
	}

	/** `on` mode keeps the host from streaming partial output of a long tool. */
	isStreamSuppressed(toolCallId: string): boolean {
		return this.mode === "on" && this.tools.get(toolCallId)?.longOutput === true;
	}

	private scheduleCollapse(tool: ToolRecord): void {
		this.clearCollapseTimer(tool);
		if (tool.longOutput !== true || this.mode === "pertrace" || this.mode === "off") return;
		if (this.mode === "on") {
			if (!this.postponeWhileReading(tool)) tool.timerCollapsed = true;
			return;
		}
		const timer = setTimeout(() => {
			delete tool.collapseTimer;
			if (this.postponeWhileReading(tool)) return;
			tool.timerCollapsed = true;
			tool.invalidate?.();
		}, AUTO_COLLAPSE_DELAY_MS);
		timer.unref();
		tool.collapseTimer = timer;
	}

	/**
	 * Collapsing removes rows, and a shrink that drops the content end below a reader who is
	 * above it clamps their viewport to the bottom. So while the user reads above the end, the
	 * collapse is postponed and re-checked until they return to the end. Returns true when the
	 * caller must not collapse now.
	 *
	 * The predicate reports a reader only in the fullscreen viewport: in regular mode the
	 * transcript is the terminal's own scrollback, which Pi can neither read nor scroll, so
	 * there the postponement never applies (see `isTuiScrolledUp`).
	 */
	private postponeWhileReading(record: ToolRecord): boolean {
		if (this.isScrolledUp?.() !== true) return false;
		if (record.collapseTimer !== undefined) return true;
		const retry = (): void => {
			const timer = setTimeout(() => {
				delete record.collapseTimer;
				if (this.postponeWhileReading(record)) return;
				record.timerCollapsed = true;
				record.invalidate?.();
			}, AUTO_COLLAPSE_RETRY_DELAY_MS);
			timer.unref();
			record.collapseTimer = timer;
		};
		retry();
		return true;
	}

	private clearCollapseTimer(tool: ToolRecord): void {
		const timer = tool.collapseTimer;
		if (timer === undefined) return;
		delete tool.collapseTimer;
		clearTimeout(timer);
	}

	completionFor(toolCallId: string): ToolCompletion | undefined {
		return this.tools.get(toolCallId)?.completion;
	}
}

type ToolRecord = {
	trace: number;
	executionStarted: boolean;
	startedAt?: number;
	longOutput?: boolean;
	/** Set once the automatic policy really collapsed this frame. */
	timerCollapsed?: boolean;
	/** The pending policy timer: the auto delay or the poll that waits out a reader. */
	collapseTimer?: ReturnType<typeof setTimeout>;
	completion?: ToolCompletion;
	latest?: AgentToolResult<unknown>;
	/** True once the call phase drew a body section, which already opens the result's rail. */
	railDrawn?: boolean;
	invalidate?: () => void;
};

function sameCompletion(
	left: ToolCompletion | undefined,
	right: ToolCompletion | undefined,
): boolean {
	return (
		left?.durationMs === right?.durationMs &&
		left?.errorMessage === right?.errorMessage &&
		left?.warning === right?.warning
	);
}

function sameResult(
	left: AgentToolResult<unknown> | undefined,
	right: AgentToolResult<unknown>,
): boolean {
	return left?.content === right.content && left?.details === right.details;
}

class ToolFrameSection implements Component {
	private readonly headerRows: (width: number) => string[];

	constructor(
		private readonly body: ToolBodySection | undefined,
		theme: Theme,
		header: FrameHeader,
		oneLineHeader = false,
	) {
		this.headerRows = memoByWidth((width: number): string[] =>
			oneLineHeader
				? [singleLineHeader(header, width, theme)]
				: new Text(`${header.primary}${header.suffix ?? ""}`, 0, 0).render(width),
		);
	}

	bodyComponent(): Component | undefined {
		return this.body?.bodyComponent();
	}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const header = this.headerRows(availableWidth);
		const body = this.body?.render(availableWidth) ?? [];
		return body.length === 0 ? header : [...header, ...body];
	}

	invalidate(): void {
		this.body?.invalidate();
	}
}

function singleLineHeader(header: FrameHeader, width: number, theme: Theme): string {
	if (header.suffix === undefined) return truncateLine(header.primary, width, theme);
	const suffixWidth = visibleWidth(header.suffix);
	if (suffixWidth >= width) return truncateLine(header.suffix, width, theme);
	return `${truncateLine(header.primary, width - suffixWidth, theme)}${header.suffix}`;
}

/** Cuts one row with a dim `…`; the Pi renderer rejects any row wider than the terminal. */
function truncateLine(text: string, width: number, theme: Theme): string {
	return truncateToWidth(text, width, theme.fg("dim", "…"));
}

/**
 * The summary row follows the header rule: it wraps by default and is cut to one row when
 * the tool declares `headerLine: "truncate"`. It never exceeds the terminal width, because
 * `wrapTextWithAnsi` breaks both words and long tokens.
 */
function footerRows(text: string, width: number, theme: Theme, oneLine: boolean): string[] {
	const painted = theme.fg("dim", text);
	return oneLine ? [truncateLine(painted, width, theme)] : wrapTextWithAnsi(painted, width);
}

/**
 * One collapsed frame row never wraps; a long typed footer is cut with a dim `…` so a
 * collapsed frame stays exactly one header row plus one summary row at every width.
 */
class SingleLineRow implements Component {
	private readonly rows: (width: number) => string[];

	constructor(text: string, theme: Theme) {
		this.rows = memoByWidth((width: number): string[] => [truncateLine(text, width, theme)]);
	}

	render(width: number): string[] {
		return this.rows(Math.max(1, width));
	}

	invalidate(): void {}
}

type HiddenHint = { readonly width: number; readonly hidden: number; readonly row: string };

type BodySectionOptions = {
	readonly footer: string | undefined;
	/** Rows an unexpanded body keeps; non-finite or < 1 disables the cap. */
	readonly maxLines: number;
	readonly expanded: boolean;
	readonly oneLineFooter: boolean;
	/** Which end of an over-long body survives the cap: output keeps its tail, input its head. */
	readonly cap: "head" | "tail";
	/** Guarantees every row fits the width, because request text is model-controlled input. */
	readonly guardWidth: boolean;
	/** Omits the opening rail because the request body above already closed its own section. */
	readonly omitOpeningRail: boolean;
};

class ToolBodySection implements Component {
	private readonly chrome: (width: number) => { readonly rail: string; readonly footer: string[] };
	private hint: HiddenHint | undefined;

	constructor(
		private readonly body: Component,
		private readonly theme: Theme,
		private readonly options: BodySectionOptions,
	) {
		this.chrome = memoByWidth((width: number) => ({
			rail: theme.fg("muted", "─".repeat(width)),
			footer:
				options.footer === undefined
					? []
					: footerRows(options.footer, width, theme, options.oneLineFooter),
		}));
	}

	bodyComponent(): Component {
		return this.body;
	}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const rendered = this.rows(availableWidth);
		const body = this.options.expanded ? rendered : this.cappedBody(rendered, availableWidth);
		const chrome = this.chrome(availableWidth);
		if (body.length === 0) return chrome.footer;
		return [
			...(this.options.omitOpeningRail ? [] : [chrome.rail]),
			...body,
			chrome.rail,
			...chrome.footer,
		];
	}

	invalidate(): void {
		this.body.invalidate();
	}

	private rows(width: number): string[] {
		const rendered = this.body.render(width);
		if (!this.options.guardWidth) return rendered;
		return rendered.map((row) =>
			visibleWidth(row) <= width ? row : truncateLine(row, width, this.theme),
		);
	}

	/** An unexpanded body keeps at most `maxLines` rows behind a dim hidden-lines hint. */
	private cappedBody(rendered: string[], width: number): readonly string[] {
		const maxLines = this.options.maxLines;
		if (!Number.isFinite(maxLines) || maxLines < 1 || rendered.length <= maxLines) return rendered;
		const hidden = rendered.length - (maxLines - 1);
		if (this.options.cap === "head")
			return [...rendered.slice(0, maxLines - 1), this.hiddenHint(hidden, width)];
		return [this.hiddenHint(hidden, width), ...rendered.slice(-(maxLines - 1))];
	}

	private hiddenHint(hidden: number, width: number): string {
		const cached = this.hint;
		if (cached !== undefined && cached.width === width && cached.hidden === hidden)
			return cached.row;
		const side = this.options.cap === "head" ? "later" : "earlier";
		const row = truncateLine(
			this.theme.fg("dim", `… (${hidden} ${side} lines, ${EXPAND_HINT})`),
			width,
			this.theme,
		);
		this.hint = { width, hidden, row };
		return row;
	}
}

function previousBody(component: Component | undefined): Component | undefined {
	return component instanceof ToolFrameSection || component instanceof ToolBodySection
		? component.bodyComponent()
		: undefined;
}

function resultFallback(result: AgentToolResult<unknown>, theme: Theme): Component {
	const text = agentResultText(result);
	return text === "" ? new Container() : new Text(theme.fg("toolOutput", text), 0, 0);
}

/** Creates one renderer owner. Most extensions should use getToolTui(pi). */
export function createToolTui(): ToolTui {
	const trace = new ToolTraceController();
	return {
		beginTrace(): void {
			trace.startTrace();
		},
		resetSession(): void {
			trace.resetSession();
		},
		setToolCollapseMode(mode: ToolCollapseMode): void {
			trace.setMode(mode);
		},
		setScrolledUpPredicate(predicate: (() => boolean) | undefined): void {
			trace.setScrolledUpPredicate(predicate);
		},
		frame<TParams extends TSchema, TDetails, TState>(
			tool: ToolDefinition<TParams, TDetails, TState>,
			presentation: ToolTuiPresentation<TParams, TDetails> = {},
		): ToolDefinition<TParams, TDetails, TState> {
			const renderCall = tool.renderCall;
			const renderResult = tool.renderResult;
			const maxBodyLines = presentation.maxBodyLines ?? DEFAULT_MAX_BODY_LINES;
			return {
				...tool,
				renderShell: "self",
				async execute(toolCallId, params, signal, onUpdate, context) {
					trace.begin(toolCallId, presentation.longOutput === true);
					const forwardUpdate = (update: AgentToolResult<TDetails>): void => {
						trace.update(toolCallId, update);
						if (trace.isStreamSuppressed(toolCallId)) return;
						onUpdate?.(update);
					};
					try {
						const result = await tool.execute(toolCallId, params, signal, forwardUpdate, context);
						trace.update(toolCallId, result);
						const warning = presentation.warning?.(result) ?? false;
						return withCompletion(result, trace.complete(toolCallId, warning));
					} catch (error) {
						trace.fail(toolCallId, error);
						throw error;
					}
				},
				renderCall(args, theme, context): Component {
					const latest = trace.latestFor(context.toolCallId) as
						| AgentToolResult<TDetails>
						| undefined;
					const previewing = context.isPartial && latest === undefined;
					const historical = previewing
						? false
						: trace.isPriorTrace(context.toolCallId, context.executionStarted, context.invalidate);
					// A call whose arguments are still streaming is never collapsed.
					const collapsed =
						!previewing &&
						trace.isCollapsed(
							context.toolCallId,
							context.expanded,
							context.executionStarted,
							context.invalidate,
						);
					const muted = collapsed || historical;
					const header = headerFor({
						tool,
						args,
						theme,
						context,
						warning: trace.completionFor(context.toolCallId)?.warning,
						summary: presentation.summary?.(args, latest, context),
						summarySeparator: presentation.summarySeparator ?? "dot",
						remotePathSummary: presentation.remotePathSummary === true,
						collapsed: muted,
						historical: muted,
						suffix: presentation.suffix?.(args),
						inlineSummary: presentation.suffix !== undefined,
					});
					if (collapsed) return new ToolFrameSection(undefined, theme, header, true);
					const innerTheme = frameTheme(theme, historical);
					const bodyContext = {
						...context,
						lastComponent: previousBody(context.lastComponent),
					};
					const request = presentation.request;
					// A declared request owns the call-phase body for the whole lifetime of the row, but it may
					// legitimately render nothing (empty command, empty code), and then no section rail exists
					// for the result to continue.
					let body: Component | undefined;
					if (request === undefined) {
						body = previewing ? renderCall?.(args, innerTheme, bodyContext) : undefined;
					} else {
						body = request(args, innerTheme, bodyContext);
					}
					trace.markRail(context.toolCallId, body !== undefined);
					return new ToolFrameSection(
						body === undefined
							? undefined
							: new ToolBodySection(body, theme, {
									footer: undefined,
									maxLines: request === undefined ? maxBodyLines : DEFAULT_MAX_REQUEST_LINES,
									expanded: context.expanded,
									oneLineFooter: presentation.headerLine === "truncate",
									cap: request === undefined ? "tail" : "head",
									guardWidth: request !== undefined,
									omitOpeningRail: false,
								}),
						theme,
						header,
						presentation.headerLine === "truncate",
					);
				},
				renderResult(result, options, theme, context): Component {
					const completion = completionFrom(result, trace.completionFor(context.toolCallId));
					const footer = typedFooter(presentation.footer?.(result, completion, options));
					const warning = presentation.warning?.(result) ?? false;
					const restoredCompletion =
						completion?.warning === true || !warning
							? completion
							: { ...completion, warning: true };
					trace.restore(context.toolCallId, result, restoredCompletion);
					const isWarning = restoredCompletion?.warning === true;
					const historical = trace.isPriorTrace(
						context.toolCallId,
						context.executionStarted,
						context.invalidate,
					);
					const collapsed = trace.isCollapsed(
						context.toolCallId,
						context.expanded,
						context.executionStarted,
						context.invalidate,
					);
					if (collapsed) {
						const summary =
							context.isError && !isWarning
								? defaultFooter(restoredCompletion, true)
								: (footer ?? defaultFooter(restoredCompletion, false));
						return new SingleLineRow(theme.fg("dim", summary), theme);
					}
					const body =
						renderResult?.(result, options, frameTheme(theme, historical), {
							...context,
							lastComponent: previousBody(context.lastComponent),
						}) ?? resultFallback(result, theme);
					return new ToolBodySection(body, theme, {
						footer,
						maxLines: maxBodyLines,
						expanded: options.expanded,
						oneLineFooter: presentation.headerLine === "truncate",
						cap: "tail",
						guardWidth: false,
						omitOpeningRail: trace.railDrawn(context.toolCallId),
					});
				},
			};
		},
	};
}

interface ToolTuiRuntimeState {
	readonly tui: ToolTui;
}

function stateFor(pi: ExtensionAPI): ToolTuiRuntimeState {
	const registry = getGlobalState(
		"tool-tui",
		(): WeakMap<object, ToolTuiRuntimeState> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const current = registry.get(identity);
	if (current !== undefined) return current;
	const created: ToolTuiRuntimeState = { tui: createToolTui() };
	registry.set(identity, created);
	return created;
}

function traceRegistrations(): WeakSet<ExtensionAPI> {
	return getGlobalState("tool-tui-trace-registrations", (): WeakSet<ExtensionAPI> => new WeakSet());
}

/** Returns the one ToolTUI instance shared by concrete extensions in this Pi host. */
export function getToolTui(pi: ExtensionAPI): ToolTui {
	return stateFor(pi).tui;
}

/**
 * Detects whether the user is reading above the end of the transcript.
 *
 * Only the fullscreen (alternate-screen) renderer owns a viewport Pi can read, through its
 * public `isFollowingOutput` flag. In regular mode the transcript is written into the
 * terminal's own scrollback: its scroll position is invisible to Pi and Pi cannot move it,
 * so this reports false there and reading protection is **unsupported by design** for that
 * mode. Do not patch or bypass it to change that answer (no pi-tui patch, no monkey-patched
 * `ScrollView`, no private members): Pi's only regular-mode obligation is to not erase the
 * scrollback, which the full-redraw rule in DESIGN.md covers.
 */
export function isTuiScrolledUp(tui: unknown): boolean {
	if (!tui || typeof tui !== "object") return false;
	return "isFollowingOutput" in tui && tui.isFollowingOutput === false;
}

/** Installs one trace lifecycle binding for each extension runtime. */
export function registerToolTuiTrace(pi: ExtensionAPI): void {
	const registrations = traceRegistrations();
	if (registrations.has(pi)) return;
	registrations.add(pi);
	const tui = stateFor(pi).tui;
	pi.on("agent_start", () => {
		tui.beginTrace();
	});
	pi.on("session_start", (event) => {
		if (event.reason !== "startup") tui.beginTrace();
	});
	// Pending collapse timers hold component callbacks from the ending session.
	pi.on("session_shutdown", () => {
		registrations.delete(pi);
		tui.resetSession();
	});
}
