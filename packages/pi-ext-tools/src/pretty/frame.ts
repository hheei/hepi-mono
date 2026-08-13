import type {
	AgentToolResult,
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

import { type ToolCompletion, ToolTraceController } from "./trace.js";

type FrameStatus = "pending" | "success" | "warning" | "error";

type FrameHeader = {
	readonly primary: string;
	readonly suffix?: string;
	readonly wrap?: boolean;
};

type ToolPresentation<TParams extends TSchema, TDetails> = {
	readonly summary?: ToolFrameHeader<TParams, TDetails>;
	readonly footer?: (
		result: AgentToolResult<TDetails>,
		completion: ToolCompletion | undefined,
		options: ToolRenderResultOptions,
	) => string | undefined;
	readonly warning?: (result: AgentToolResult<TDetails>) => boolean;
};

export interface ToolTui {
	beginTrace(): void;
	frame<TParams extends TSchema, TDetails, TState>(
		tool: ToolDefinition<TParams, TDetails, TState>,
		presentation?: ToolPresentation<TParams, TDetails>,
	): ToolDefinition<TParams, TDetails, TState>;
}

type ToolFrameHeader<TParams extends TSchema, TDetails> = (
	args: Static<TParams>,
	latest: AgentToolResult<TDetails> | undefined,
) => string | undefined;

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

function textValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function argsRecord(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function summaryFor(tool: string, args: unknown): string {
	const values = argsRecord(args);
	const path = textValue(values.path) ?? textValue(values.file_path);
	const pattern = textValue(values.pattern);
	const command = textValue(values.command);
	const action = textValue(values.action);
	const id = textValue(values.id);

	if (tool === "grep" && pattern !== undefined)
		return path === undefined ? `/${pattern}/` : `/${pattern}/ in ${path}`;
	if (tool === "find" && pattern !== undefined)
		return path === undefined ? pattern : `${pattern} in ${path}`;
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
	collapsed = false,
): FrameHeader {
	const status = statusPrefix(
		warning ? "warning" : context.isError ? "error" : statusFor(context),
		theme,
	);
	const values = argsRecord(args);
	if (summaryOverride !== undefined)
		return {
			primary: `${status} ${theme.fg("toolTitle", theme.bold(tool.label))} ${theme.fg("dim", "·")} ${theme.fg("dim", summaryOverride)}`,
		};
	const pattern = textValue(values.pattern);
	const path = textValue(values.path);
	const command = textValue(values.command);
	if (tool.name === "bash" && command !== undefined) {
		const timeout = typeof values.timeout === "number" ? values.timeout : undefined;
		return {
			primary: `${status} ${theme.fg("toolTitle", theme.bold(tool.label))} ${collapsed ? theme.fg("dim", command.split("\n")[0] ?? command) : command}`,
			...(timeout === undefined ? {} : { suffix: theme.fg("dim", ` (timeout ${timeout}s)`) }),
			...(collapsed ? {} : { wrap: true }),
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
			primary: `${status} ${theme.fg("toolTitle", theme.bold(tool.label))} ${collapsed ? theme.fg("dim", path) : path}${theme.fg(collapsed ? "dim" : "warning", range)}`,
		};
	}
	if ((tool.name === "grep" || tool.name === "find") && pattern !== undefined) {
		if (collapsed)
			return {
				primary: `${status} ${theme.fg("toolTitle", theme.bold(tool.label))} ${theme.fg("dim", `/${pattern}/${path === undefined ? "" : ` in ${path}`}`)}`,
			};
		const summary = [
			theme.fg("toolTitle", theme.bold(tool.label)),
			theme.fg("mdCode", `/${pattern}/`),
			...(path === undefined ? [] : ["in", theme.fg("dim", path)]),
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
			: this.header.wrap
				? new Text(`${this.header.primary}${this.header.suffix ?? ""}`, 0, 0).render(availableWidth)
				: [
						truncateToWidth(
							`${this.header.primary}${this.header.suffix ?? ""}`,
							availableWidth,
							"…",
						),
					];
		lines.push(...(this.body?.render(availableWidth) ?? []));
		return lines;
	}

	invalidate(): void {
		this.body?.invalidate();
	}
}

function collapsedHeader(header: FrameHeader, width: number, theme: Theme): string {
	const truncation = theme.fg("dim", ">");
	if (header.suffix === undefined) return truncateToWidth(header.primary, width, truncation);
	const suffixWidth = visibleWidth(header.suffix);
	if (suffixWidth >= width) return truncateToWidth(header.suffix, width, truncation);
	return `${truncateToWidth(header.primary, width - suffixWidth, truncation)}${header.suffix}`;
}

class ToolBodySection implements Component {
	constructor(
		private readonly body: Component,
		private readonly footer: string | undefined,
		private readonly theme: Theme,
	) {}

	bodyComponent(): Component {
		return this.body;
	}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const body = this.body.render(availableWidth);
		if (body.length === 0)
			return this.footer === undefined ? [] : [this.theme.fg("dim", this.footer)];
		return [
			this.theme.fg("borderMuted", "─".repeat(availableWidth)),
			...body,
			this.theme.fg("borderMuted", "─".repeat(availableWidth)),
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

/** Creates one session-scoped owner for framed tool rendering and Trace state. */
export function createToolTui(): ToolTui {
	const trace = new ToolTraceController();
	return {
		beginTrace(): void {
			trace.startTrace();
		},
		frame<TParams extends TSchema, TDetails, TState>(
			tool: ToolDefinition<TParams, TDetails, TState>,
			presentation: ToolPresentation<TParams, TDetails> = {},
		): ToolDefinition<TParams, TDetails, TState> {
			const renderCall = tool.renderCall;
			const renderResult = tool.renderResult;
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
					const collapsed = trace.isCollapsed(
						context.toolCallId,
						context.expanded,
						context.executionStarted,
						context.invalidate,
					);
					const latest = trace.latestFor(context.toolCallId) as
						| AgentToolResult<TDetails>
						| undefined;
					const header = headerFor(
						tool,
						args,
						theme,
						context,
						trace.completionFor(context.toolCallId)?.warning,
						presentation.summary?.(args, latest),
						collapsed,
					);
					if (collapsed) return new ToolFrameSection(undefined, theme, header, true);
					const body =
						context.isPartial && latest === undefined
							? renderCall?.(args, unboxedTheme(theme), {
									...context,
									lastComponent: previousBody(context.lastComponent),
								})
							: undefined;
					return new ToolFrameSection(
						body === undefined ? undefined : new ToolBodySection(body, undefined, theme),
						theme,
						header,
					);
				},
				renderResult(result, options, theme, context): Component {
					const completion = completionFrom(result, trace.completionFor(context.toolCallId));
					const footer = presentation.footer?.(result, completion, options);
					const warning = presentation.warning?.(result) ?? false;
					const restoredCompletion =
						completion?.warning === true || !warning
							? completion
							: { ...completion, warning: true };
					trace.restore(context.toolCallId, result, restoredCompletion);
					const isWarning = restoredCompletion?.warning === true;
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
						return new Text(theme.fg("dim", summary), 0, 0);
					}
					const body =
						renderResult?.(result, options, unboxedTheme(theme), {
							...context,
							lastComponent: previousBody(context.lastComponent),
						}) ?? resultFallback(result, theme);
					return new ToolBodySection(body, footer, theme);
				},
			};
		},
	};
}
