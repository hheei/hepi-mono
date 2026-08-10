import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";

import { type ToolCompletion, ToolTraceController } from "./trace.js";

type FrameStatus = "pending" | "success" | "warning" | "error";

export type ToolFrameFooter = (
	result: AgentToolResult<unknown>,
	completion: ToolCompletion | undefined,
) => string | undefined;

export type ToolFrameHeader<TParams extends TSchema, TDetails> = (
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
			if (property !== "bg") return Reflect.get(target, property, receiver);
			return (role: Parameters<Theme["bg"]>[0], text: string): string =>
				TOOL_BACKGROUNDS.has(role) ? text : target.bg(role, text);
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
): string {
	const status = statusPrefix(
		warning ? "warning" : context.isError ? "error" : statusFor(context),
		theme,
	);
	const values = argsRecord(args);
	if (summaryOverride !== undefined)
		return `${status} ${theme.fg("toolTitle", theme.bold(tool.label))} ${theme.fg("dim", "·")} ${theme.fg("dim", summaryOverride)}`;
	const pattern = textValue(values.pattern);
	const path = textValue(values.path);
	if (tool.name === "read" && path !== undefined) {
		const offset = typeof values.offset === "number" ? values.offset : undefined;
		const limit = typeof values.limit === "number" ? values.limit : undefined;
		const range =
			limit === undefined
				? offset === undefined
					? ""
					: `:${offset}`
				: `:${offset ?? 1}-${(offset ?? 1) + limit - 1}`;
		return `${status} ${theme.fg("toolTitle", theme.bold(tool.label))} ${path}${theme.fg("warning", range)}`;
	}
	if (tool.name === "grep" && pattern !== undefined) {
		const summary = [
			theme.fg("accent", "grep"),
			theme.fg("mdCode", `/${pattern}/`),
			...(path === undefined ? [] : ["in", theme.fg("dim", path)]),
		].join(" ");
		return `${status} ${summary}`;
	}
	const summary = summaryFor(tool.name, args);
	return [
		status,
		theme.fg("toolTitle", theme.bold(tool.label)),
		...(summary === "" ? [] : [theme.fg("dim", summary)]),
	].join(" ");
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

export function completionFromResult(result: AgentToolResult<unknown>): ToolCompletion | undefined {
	return completionFrom(result, undefined);
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
		private readonly body: Component | undefined,
		private readonly theme: Theme,
		private readonly header?: string,
		private readonly separateBody = true,
	) {}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const lines =
			this.header === undefined ? [] : [truncateToWidth(this.header, availableWidth, "…")];
		const bodyLines = this.body?.render(availableWidth) ?? [];
		if (bodyLines.length > 0) {
			if (this.separateBody) lines.push(this.theme.fg("borderMuted", "─".repeat(availableWidth)));
			else lines.push("");
			lines.push(...bodyLines);
		}
		return lines;
	}

	invalidate(): void {
		this.body?.invalidate();
	}
}

function resultFallback(result: AgentToolResult<unknown>, theme: Theme): Component {
	const text = resultText(result);
	return text === "" ? new Container() : new Text(theme.fg("toolOutput", text), 0, 0);
}

/**
 * Adds Pi-native unboxed framing around a tool's existing renderer without
 * changing its schema, execution, model content, or result details.
 */
export function withToolFrame<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	trace = new ToolTraceController(),
	footer?: ToolFrameFooter,
	warningResult?: (result: AgentToolResult<unknown>) => boolean,
	headerSummary?: ToolFrameHeader<TParams, TDetails>,
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
				return withCompletion(result, trace.complete(toolCallId, warningResult?.(result) ?? false));
			} catch (error) {
				trace.fail(toolCallId, error);
				throw error;
			}
		},
		renderCall(args, theme, context): Component {
			const header = headerFor(
				tool,
				args,
				theme,
				context,
				trace.completionFor(context.toolCallId)?.warning,
				headerSummary?.(
					args,
					trace.latestFor(context.toolCallId) as AgentToolResult<TDetails> | undefined,
				),
			);
			if (
				trace.isCollapsed(
					context.toolCallId,
					context.expanded,
					context.executionStarted,
					context.invalidate,
				)
			)
				return new ToolFrameSection(undefined, theme, header);
			const body = renderCall?.(args, unboxedTheme(theme), {
				...context,
				lastComponent: undefined,
			});
			return new ToolFrameSection(body, theme, header);
		},
		renderResult(result, options, theme, context): Component {
			const completion = completionFrom(result, trace.completionFor(context.toolCallId));
			const isWarning = completion?.warning === true;
			const header = headerFor(
				tool,
				context.args,
				theme,
				context,
				isWarning,
				headerSummary?.(context.args, result),
			);
			if (
				trace.isCollapsed(
					context.toolCallId,
					context.expanded,
					context.executionStarted,
					context.invalidate,
				)
			) {
				const summary =
					context.isError && !isWarning
						? defaultFooter(completion, true)
						: (footer?.(result, completion) ?? defaultFooter(completion, false));
				return new ToolFrameSection(new Text(theme.fg("dim", summary), 0, 0), theme, header, false);
			}
			const body =
				renderResult?.(result, options, unboxedTheme(theme), {
					...context,
					lastComponent: undefined,
				}) ?? resultFallback(result, theme);
			return new ToolFrameSection(body, theme);
		},
	};
}
