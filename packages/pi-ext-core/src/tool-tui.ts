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
} from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import { getGlobalState } from "./global-state.js";
import { runtimeIdentity } from "./runtime-identity.js";

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

export type ToolTuiPresentation<TParams extends TSchema, TDetails> = {
	readonly summary?: ToolFrameHeader<TParams, TDetails>;
	readonly summarySeparator?: "dot" | "space";
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
};

export interface ToolTui {
	beginTrace(): void;
	frame<TParams extends TSchema, TDetails, TState>(
		tool: ToolDefinition<TParams, TDetails, TState>,
		presentation?: ToolTuiPresentation<TParams, TDetails>,
	): ToolDefinition<TParams, TDetails, TState>;
}

type ToolFrameHeader<TParams extends TSchema, TDetails> = (
	args: Static<TParams>,
	latest: AgentToolResult<TDetails> | undefined,
	context?: { readonly state?: unknown },
) => string | undefined;

export const DEFAULT_MAX_BODY_LINES = 20;
const EXPAND_HINT = "ctrl+o to expand";
const COMPLETION_KEY = "__piExtToolsCompletion";

const TOOL_BACKGROUNDS: ReadonlySet<Parameters<Theme["bg"]>[0]> = new Set([
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
]);

function unboxedTheme(theme: Theme): Theme {
	return new Proxy(theme, {
		get(target, property, receiver): unknown {
			if (property === "bg")
				return (role: Parameters<Theme["bg"]>[0], text: string): string =>
					TOOL_BACKGROUNDS.has(role) ? text : target.bg(role, text);
			return Reflect.get(target, property, receiver);
		},
	});
}

function toneTheme(theme: Theme, historical: boolean): Theme {
	return new Proxy(theme, {
		get(target, property, receiver): unknown {
			if (property === "fg")
				return (role: Parameters<Theme["fg"]>[0], text: string): string =>
					role === "text" ? (historical ? target.fg("dim", text) : text) : target.fg(role, text);
			return Reflect.get(target, property, receiver);
		},
	});
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function argsRecord(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
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

function summaryFor(tool: string, args: unknown): string {
	const values = argsRecord(args);
	const path = textValue(values.path) ?? textValue(values.file_path);
	const pattern = textValue(values.pattern);
	const command = textValue(values.command);
	const action = textValue(values.action);
	const id = textValue(values.id);
	const location = path === undefined ? undefined : remoteLocation(values, path);

	if (tool === "grep" && pattern !== undefined)
		return location === undefined ? `/${pattern}/` : `/${pattern}/ in ${location}`;
	if (tool === "find" && pattern !== undefined)
		return location === undefined ? pattern : `${pattern} in ${location}`;
	if (command !== undefined) return command.split("\n")[0] ?? command;
	if (path !== undefined) return path;
	if (action !== undefined && id !== undefined) return `${action} ${id}`;
	return "";
}

function headerFor(
	tool: { readonly name: string; readonly label: string },
	args: unknown,
	theme: Theme,
	context: { readonly isError: boolean; readonly isPartial: boolean },
	warning = false,
	summaryOverride?: string,
	summarySeparator: "dot" | "space" = "dot",
	remotePathSummary = false,
	collapsed = false,
	historical = collapsed,
): FrameHeader {
	const status = statusPrefix(
		warning ? "warning" : context.isError ? "error" : statusFor(context),
		theme,
	);
	const values = argsRecord(args);
	const path = textValue(values.path);
	if (summaryOverride !== undefined) {
		if (remotePathSummary && path !== undefined) {
			return {
				primary: `${status} ${theme.fg("toolTitle", theme.bold(tool.label))}${summarySeparator === "dot" ? ` ${theme.fg("dim", "·")}` : ""} ${paintRemotePath(values, path, theme, collapsed)}`,
			};
		}
		const host = remoteTarget(values);
		const hostLabel =
			host === undefined ? "" : `${theme.fg(collapsed ? "dim" : "warning", `(${host})`)} `;
		const summary = collapsed ? theme.fg("dim", summaryOverride) : summaryOverride;
		return {
			primary: `${status} ${theme.fg("toolTitle", theme.bold(tool.label))}${summarySeparator === "dot" ? ` ${theme.fg("dim", "·")}` : ""} ${hostLabel}${summary}`,
		};
	}
	const pattern = textValue(values.pattern);
	const command = textValue(values.command);
	if (tool.name === "bash" && command !== undefined) {
		const timeout = typeof values.timeout === "number" ? values.timeout : undefined;
		const shown = collapsed ? (command.split("\n")[0] ?? command) : command;
		const host = remoteTarget(values);
		const hostLabel =
			host === undefined ? "" : `${theme.fg(collapsed ? "dim" : "warning", `(${host})`)} `;
		return {
			primary: `${status} ${theme.fg("toolTitle", theme.bold(tool.label))} ${hostLabel}${theme.fg(collapsed ? "dim" : "muted", shown)}`,
			...(timeout === undefined ? {} : { suffix: theme.fg("dim", ` (timeout ${timeout}s)`) }),
		};
	}
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
	const summary = summaryFor(tool.name, args);
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
			return theme.fg("warning", "◐");
		case "success":
			return theme.fg("success", "✓");
		case "warning":
			return theme.fg("warning", "!");
		case "error":
			return theme.fg("error", "✗");
	}
}

function durationText(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
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
		details: (typeof details === "object" && details !== null && !Array.isArray(details)
			? { ...details, [COMPLETION_KEY]: completion }
			: { [COMPLETION_KEY]: completion }) as T,
	};
}

function typedFooter(value: string | undefined): string | undefined {
	const footer = value?.trim();
	return footer === undefined || footer === "" ? undefined : footer;
}

function defaultFooter(completion: ToolCompletion | undefined, isError: boolean): string {
	const duration = durationText(completion?.durationMs);
	if (isError) return [completion?.errorMessage ?? "failed", duration].filter(Boolean).join(" · ");
	return duration ?? "completed";
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

class ToolTraceController {
	private trace = 0;
	private readonly tools = new Map<string, ToolRecord>();

	startTrace(): void {
		this.trace += 1;
		for (const tool of this.tools.values()) {
			if (tool.trace < this.trace) tool.invalidate?.();
		}
	}

	begin(toolCallId: string): void {
		this.tools.set(toolCallId, { trace: this.trace, startedAt: performance.now() });
	}

	complete(toolCallId: string, warning = false): ToolCompletion {
		const tool = this.tools.get(toolCallId);
		const completion = {
			...(tool?.startedAt === undefined
				? {}
				: { durationMs: Math.round(performance.now() - tool.startedAt) }),
			...(warning ? { warning: true } : {}),
		};
		if (tool !== undefined) tool.completion = completion;
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
		if (changed) queueMicrotask(() => tool.invalidate?.());
	}

	latestFor(toolCallId: string): AgentToolResult<unknown> | undefined {
		return this.tools.get(toolCallId)?.latest;
	}

	observe(toolCallId: string, executionStarted: boolean, invalidate: () => void): ToolRecord {
		const existing = this.tools.get(toolCallId);
		if (existing !== undefined) {
			existing.invalidate = invalidate;
			return existing;
		}
		const tool = { trace: executionStarted ? this.trace : -1, invalidate };
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

	isCollapsed(
		toolCallId: string | undefined,
		expanded: boolean,
		executionStarted: boolean,
		invalidate: () => void,
	): boolean {
		return !expanded && this.isPriorTrace(toolCallId, executionStarted, invalidate);
	}

	completionFor(toolCallId: string): ToolCompletion | undefined {
		return this.tools.get(toolCallId)?.completion;
	}
}

type ToolRecord = {
	trace: number;
	startedAt?: number;
	completion?: ToolCompletion;
	latest?: AgentToolResult<unknown>;
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
	constructor(
		private readonly body: ToolBodySection | undefined,
		private readonly theme: Theme,
		private readonly header: FrameHeader,
		private readonly collapsed = false,
	) {}

	bodyComponent(): Component | undefined {
		return this.body?.bodyComponent();
	}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const lines = this.collapsed
			? [collapsedHeader(this.header, availableWidth, this.theme)]
			: new Text(`${this.header.primary}${this.header.suffix ?? ""}`, 0, 0).render(availableWidth);
		lines.push(...(this.body?.render(availableWidth) ?? []));
		return lines;
	}

	invalidate(): void {
		this.body?.invalidate();
	}
}

function collapsedHeader(header: FrameHeader, width: number, theme: Theme): string {
	const truncation = theme.fg("dim", "…");
	if (header.suffix === undefined) return truncateToWidth(header.primary, width, truncation);
	const suffixWidth = visibleWidth(header.suffix);
	if (suffixWidth >= width) return truncateToWidth(header.suffix, width, truncation);
	return `${truncateToWidth(header.primary, width - suffixWidth, truncation)}${header.suffix}`;
}

function compactBodyLines(
	lines: readonly string[],
	maxBodyLines: number,
	width: number,
	theme: Theme,
): string[] {
	if (!Number.isFinite(maxBodyLines) || maxBodyLines < 1 || lines.length <= maxBodyLines)
		return [...lines];
	const visible = lines.slice(-(maxBodyLines - 1));
	const hint = theme.fg(
		"dim",
		`… (${lines.length - visible.length} earlier lines, ${EXPAND_HINT})`,
	);
	return [truncateToWidth(hint, width, theme.fg("dim", "…")), ...visible];
}

class ToolBodySection implements Component {
	constructor(
		private readonly body: Component,
		private readonly footer: string | undefined,
		private readonly theme: Theme,
		private readonly maxBodyLines: number,
		private readonly expanded = false,
	) {}

	bodyComponent(): Component {
		return this.body;
	}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const rendered = this.body.render(availableWidth);
		const body = this.expanded
			? rendered
			: compactBodyLines(rendered, this.maxBodyLines, availableWidth, this.theme);
		if (body.length === 0)
			return this.footer === undefined ? [] : [this.theme.fg("dim", this.footer)];
		const rail = this.theme.fg("muted", "─".repeat(availableWidth));
		return [
			rail,
			...body,
			rail,
			...(this.footer === undefined ? [] : [this.theme.fg("dim", this.footer)]),
		];
	}

	invalidate(): void {
		this.body.invalidate();
	}
}

function previousBody(component: Component | undefined): Component | undefined {
	return component instanceof ToolFrameSection || component instanceof ToolBodySection
		? component.bodyComponent()
		: undefined;
}

function resultFallback(result: AgentToolResult<unknown>, theme: Theme): Component {
	const text = resultText(result);
	return text === "" ? new Container() : new Text(theme.fg("toolOutput", text), 0, 0);
}

/** Creates one renderer owner. Most extensions should use getToolTui(pi). */
export function createToolTui(): ToolTui {
	const trace = new ToolTraceController();
	return {
		beginTrace(): void {
			trace.startTrace();
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
					trace.begin(toolCallId);
					const forwardUpdate = (update: AgentToolResult<TDetails>): void => {
						trace.update(toolCallId, update);
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
					const collapsed = !context.expanded && historical;
					const header = headerFor(
						tool,
						args,
						theme,
						context,
						trace.completionFor(context.toolCallId)?.warning,
						presentation.summary?.(args, latest, context),
						presentation.summarySeparator,
						presentation.remotePathSummary,
						collapsed,
						historical,
					);
					if (collapsed) return new ToolFrameSection(undefined, theme, header, true);
					const innerTheme = toneTheme(unboxedTheme(theme), historical);
					const body =
						context.isPartial && latest === undefined
							? renderCall?.(args, innerTheme, {
									...context,
									lastComponent: previousBody(context.lastComponent),
								})
							: undefined;
					return new ToolFrameSection(
						body === undefined
							? undefined
							: new ToolBodySection(body, undefined, theme, maxBodyLines, context.expanded),
						theme,
						header,
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
					const collapsed = !context.expanded && historical;
					if (collapsed) {
						const summary =
							context.isError && !isWarning
								? defaultFooter(restoredCompletion, true)
								: (footer ?? defaultFooter(restoredCompletion, false));
						return new Text(theme.fg("dim", summary), 0, 0);
					}
					const body =
						renderResult?.(result, options, toneTheme(unboxedTheme(theme), historical), {
							...context,
							lastComponent: previousBody(context.lastComponent),
						}) ?? resultFallback(result, theme);
					return new ToolBodySection(body, footer, theme, maxBodyLines, options.expanded);
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
	pi.on("session_shutdown", () => {
		registrations.delete(pi);
	});
}
