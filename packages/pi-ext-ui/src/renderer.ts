import {
	type AgentToolResult,
	type ExtensionAPI,
	getLanguageFromPath,
	highlightCode,
	type Theme,
	type ToolRendererResolver,
	type ToolRenderers,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	agentResultText,
	getRegisteredToolPresentationProvider,
	getToolPresentationProvider,
	hasOptionalToolRenderers,
	type ToolPresentation,
	type ToolPresentationProvider,
} from "@hheei/pi-ext-core";
import { DiffView } from "./diff-view.js";
import { NestedCallsView } from "./nested-calls-view.js";
import {
	type FoldLevel,
	formatToolHeaderText,
	type RailColorToken,
	type RailSection,
	type ToolStatusKind,
	ToolView,
	type ToolViewCopySpec,
} from "./tool-view.js";
import {
	type CapturedToolCall,
	getCapturedNestedCalls,
	recordToolExecutionEnd,
	recordToolExecutionStart,
} from "./tracker.js";

export type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

/**
 * Upstream tools whose call and result views pi-ext-ui still frames itself. Concrete tool packages
 * own their own presentation through ext-core's optional renderer point, so their names never
 * appear here.
 */
export const SPECIALIZED_TOOL_RENDERERS = ["codemode"] as const;

export type SpecializedToolRendererName = (typeof SPECIALIZED_TOOL_RENDERERS)[number];

/** Web-access tools use the shared folding shell while retaining their native body renderer. */
export const WEB_ACCESS_TOOLS = ["web_search", "web_fetch", "web_open"] as const;

export type WebAccessToolName = (typeof WEB_ACCESS_TOOLS)[number];

import {
	callStatsParts,
	estimateStreamingTokens,
	extractHeavyInputCommand,
	extractNestedCalls,
	extractResultText,
	extractSummaryArg,
	formatCostUsd,
	formatDurationMs,
	inlinePresentation,
	isRecord,
	type NestedCallRecord,
	resolveContainerStatus,
	toolPath,
} from "./payload-parser.js";

export {
	estimateStreamingTokens,
	inlinePresentation,
	type NestedCallRecord,
} from "./payload-parser.js";

const SPECIALIZED_TOOL_SET: ReadonlySet<string> = new Set(SPECIALIZED_TOOL_RENDERERS);
const WEB_ACCESS_TOOL_SET: ReadonlySet<string> = new Set(WEB_ACCESS_TOOLS);
const CALL_VIEW_STATE_KEY = "__piExtUiCallView";

export interface CollapsibleToolRendererOptions {
	readonly tools?: readonly string[] | undefined;
	readonly match?: ((toolName: string) => boolean) | undefined;
	readonly catchAll?: boolean | undefined;
	readonly defaultCollapsed?: boolean | undefined;
	readonly copyToClipboard?: ((text: string) => Promise<void>) | undefined;
}

function detectCodeLanguage(toolName: string): string | undefined {
	if (toolName === "bash") return "bash";
	if (toolName === "codemode") return "javascript";
	return undefined;
}

function createInputCodeSection(
	toolName: string,
	args: unknown,
	theme: Theme,
	railToken: RailColorToken = "muted",
): RailSection | undefined {
	const raw = extractHeavyInputCommand(toolName, args);
	if (raw === undefined || raw === "") return undefined;
	const isShell = toolName === "bash";
	const clean = raw.replace(/\r/g, "").replace(/\t/g, "  ");
	const lang = detectCodeLanguage(toolName);

	let lines: string[];
	if (isShell) {
		lines = clean.split("\n").map((line, i) => (i === 0 ? `$ ${line}` : `  ${line}`));
	} else {
		try {
			lines = highlightCode(clean, lang);
		} catch {
			lines = clean.split("\n").map((line) => theme.fg("mdCode", line));
		}
	}

	return { railToken, content: lines };
}

function formatArgsPreview(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return stripTerminalSequences(args);
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return "";
	}
}

/**
 * The host stacks a tool execution's call and result views. Following the
 * official edit renderer, the call view is stored in the shared renderer
 * state so the result renderer can hide it in place within the same
 * updateDisplay pass — no draw-time flags needed.
 *
 * The call row is left visible until a result view exists: hiding it here would
 * blank the whole execution for as long as the tool produces no result yet.
 */
function rememberCallView(context: ToolRenderContext, view: ToolView): void {
	if (isRecord(context.state)) {
		context.state[CALL_VIEW_STATE_KEY] = view;
	}
}

/**
 * A result view takes over from the call view. A container tool yields on any result, because its
 * own row would duplicate the nested rows and output it now carries; every other tool keeps its
 * call row until the final result. A provider states that for its own tool, so no name is involved.
 */
function hideCallView(
	context: ToolRenderContext,
	replaceCallOnPartial: boolean,
	isPartial: boolean,
): void {
	if (!replaceCallOnPartial && isPartial) return;
	const view = isRecord(context.state) ? context.state[CALL_VIEW_STATE_KEY] : undefined;
	if (view instanceof ToolView) view.hide();
}

function formatNestedCallRow(call: NestedCallRecord, theme: Theme): string {
	const inline = inlinePresentation(call.toolName, call.summary, undefined, call.isError === true);
	const status: ToolStatusKind =
		call.status === "running"
			? "running"
			: call.isWarning === true
				? "warn"
				: (inline?.status ?? (call.isError === true ? "error" : "ok"));
	const cleanArgs =
		inline !== undefined || call.summary === undefined
			? ""
			: stripTerminalSequences(call.summary.trim());
	const truncatedArgs = cleanArgs.length > 72 ? `${cleanArgs.slice(0, 69)}…` : cleanArgs;
	const costText = formatCostUsd(call.cost);
	return formatToolHeaderText(
		{
			status,
			title: call.toolName,
			summary: [inline?.summary ?? truncatedArgs, formatDurationMs(call.durationMs), costText]
				.filter(Boolean)
				.join(" · "),
		},
		theme,
	);
}

function shouldInterceptTool(
	toolName: string,
	options: CollapsibleToolRendererOptions | undefined,
): boolean {
	if (options?.catchAll === true) {
		return options.match !== undefined ? options.match(toolName) : true;
	}
	if (options?.match?.(toolName)) {
		return true;
	}
	const toolList = options?.tools;
	if (toolList !== undefined) {
		return toolList.includes(toolName);
	}
	return SPECIALIZED_TOOL_SET.has(toolName) || WEB_ACCESS_TOOL_SET.has(toolName);
}

function renderGenericResult(params: {
	readonly toolName: string;
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly result: AgentToolResult<unknown>;
	readonly renderOptions: ToolRenderResultOptions;
	readonly defaultLevel: FoldLevel;
	readonly originalRenderCall?:
		| ((args: unknown, theme: Theme, context: ToolRenderContext) => Component)
		| undefined;
	readonly originalRenderResult?:
		| ((
				result: AgentToolResult<unknown>,
				options: ToolRenderResultOptions,
				theme: Theme,
				context: ToolRenderContext,
		  ) => Component)
		| undefined;
	readonly options: CollapsibleToolRendererOptions | undefined;
	readonly resolvePresentation?:
		| ((toolName: string) => ToolPresentationProvider | undefined)
		| undefined;
}): ToolView {
	const {
		toolName,
		theme,
		context,
		result,
		renderOptions,
		defaultLevel,
		originalRenderCall,
		originalRenderResult,
		resolvePresentation,
		options,
	} = params;

	const heavyCmd = extractHeavyInputCommand(toolName, context.args);
	const nestedCalls = extractNestedCalls(result);
	const captured =
		toolName === "codemode"
			? (getCapturedNestedCalls(context.toolCallId) ??
				(isRecord(result.details) &&
				Array.isArray((result.details as Record<string, unknown>).__piExtUiCapturedCalls)
					? ((result.details as Record<string, unknown>)
							.__piExtUiCapturedCalls as CapturedToolCall[])
					: undefined))
			: undefined;
	const childCalls = captured ?? nestedCalls;
	const isMetaTool = toolName === "codemode" || toolName === "subagent" || childCalls.length > 0;
	const { outputText: rawOutput, wallTimeSeconds } = extractResultText(toolName, result);
	const isError = (context.isError ?? false) || (result.isError ?? false);

	const status: ToolStatusKind =
		toolName === "codemode"
			? childCalls.length === 0 && isError
				? "error"
				: "none"
			: isMetaTool
				? resolveContainerStatus({
						isError,
						isPartial: renderOptions.isPartial === true,
						hasChildren: childCalls.length > 0,
						selfFailed: childCalls.length === 0 && isError,
					})
				: isError
					? "error"
					: renderOptions.isPartial
						? "running"
						: "ok";

	const summaryParts: string[] = [];
	const argSummary = extractSummaryArg(toolName, context.args);
	if (argSummary !== "") {
		summaryParts.push(argSummary);
	} else if (originalRenderCall !== undefined && toolName !== "codemode") {
		const upstreamLines = originalRenderCall(context.args, theme, context).render(120);
		const firstLine = stripTerminalSequences(upstreamLines[0] ?? "").trim();
		const stripped = firstLine.startsWith(toolName)
			? firstLine.slice(toolName.length).trim()
			: firstLine;
		if (stripped !== "") summaryParts.push(stripped);
	}

	if (isMetaTool && childCalls.length > 0) {
		const failCount = childCalls.filter((c) =>
			Boolean(c.isError || ("status" in c && c.status === "error")),
		).length;
		summaryParts.push(...callStatsParts(childCalls.length, failCount));
	}

	if (context.durationMs !== undefined) {
		summaryParts.push(formatDurationMs(context.durationMs));
	} else if (wallTimeSeconds !== undefined && Number.isFinite(wallTimeSeconds)) {
		summaryParts.push(formatDurationMs(wallTimeSeconds * 1000));
	}

	const totalCost = childCalls.reduce((sum, c) => sum + (c.cost ?? 0), 0);
	if (totalCost > 0) {
		summaryParts.push(formatCostUsd(totalCost));
	}

	const summary = summaryParts.join(" · ");

	const codemodeNestedView =
		toolName === "codemode" && childCalls.length > 0
			? new NestedCallsView({
					calls: childCalls,
					theme,
					context,
					resolveChildRenderer: (childName: string) => {
						return {
							renderResult: (childResult, childOptions, childTheme, childCtx) => {
								const provider = resolvePresentation?.(childName);
								if (provider !== undefined) {
									return renderOwnedPresentation({
										toolName: childName,
										presentation: provider(childCtx.args, childResult, childTheme, childCtx),
										result: childResult,
										theme: childTheme,
										context: childCtx,
										defaultLevel: childOptions.expanded ? 2 : 1,
										options,
									});
								}

								return renderGenericResult({
									toolName: childName,
									theme: childTheme,
									context: childCtx,
									result: childResult,
									renderOptions: childOptions,
									defaultLevel: childOptions.expanded ? 2 : 1,
									originalRenderCall: undefined,
									originalRenderResult: undefined,
									resolvePresentation,
									options,
								});
							},
						};
					},
					copyToClipboard: options?.copyToClipboard,
					stateHolder: context.state,
					resolvePresentation,
					invalidate: () => context.invalidate(),
				})
			: undefined;

	const collapsedRows =
		codemodeNestedView !== undefined
			? codemodeNestedView
			: isMetaTool && nestedCalls.length > 0
				? nestedCalls.map((call) => formatNestedCallRow(call, theme))
				: undefined;

	const toolRailToken: RailColorToken = isError
		? "error"
		: renderOptions.isPartial
			? "accent"
			: "success";

	// Upper room (input code) uses neutral/muted rail; lower room (output) uses toolRailToken (success/error)
	const inputSection = createInputCodeSection(toolName, context.args, theme, "muted");
	const sections: RailSection[] = inputSection !== undefined ? [inputSection] : [];

	if (toolName === "codemode") {
		// Nested tool calls belong only to collapsedRows (Level 0), hidden when expanded
		if (rawOutput !== "") {
			const rawLines = rawOutput.replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
			const outputLines = isError
				? rawLines.map((line) => theme.fg("error", line))
				: rawLines.map((line) => theme.fg("dim", line));
			sections.push({
				railToken: toolRailToken,
				content: outputLines,
			});
		}
	} else if (originalRenderResult !== undefined) {
		const viewProbe = new ToolView({
			theme,
			header: { title: toolName },
			stateHolder: context.state,
			defaultLevel,
			globalExpanded: renderOptions.expanded,
		});
		const effectiveExpanded = viewProbe.effectiveLevel === 2;
		const effectiveOptions: ToolRenderResultOptions = {
			...renderOptions,
			expanded: effectiveExpanded,
		};
		const lazyUpstreamComponent: Component = {
			render(w: number): string[] {
				return originalRenderResult(result, effectiveOptions, theme, context).render(w);
			},
			invalidate(): void {},
		};
		sections.push({
			railToken: toolRailToken,
			content: lazyUpstreamComponent,
			maxLines: effectiveExpanded ? Number.POSITIVE_INFINITY : 9,
		});
	} else if (rawOutput !== "") {
		const rawLines = rawOutput.split("\n");
		let outputLines: string[];
		if (isError) {
			outputLines = rawLines.map((line) => theme.fg("error", line));
		} else if (toolName === "read" || toolPath(context.args) !== "") {
			const filePath = toolPath(context.args);
			const lang = filePath !== "" ? getLanguageFromPath(filePath) : undefined;
			if (lang !== undefined) {
				try {
					outputLines = highlightCode(rawOutput, lang);
				} catch {
					outputLines = rawLines;
				}
			} else {
				outputLines = rawLines;
			}
		} else if (toolName === "bash") {
			outputLines = rawLines.map((line) => theme.fg("dim", line));
		} else {
			outputLines = rawLines;
		}
		sections.push({
			railToken: toolRailToken,
			content: outputLines,
		});
	}
	let copy: ToolViewCopySpec | undefined;
	if (toolName === "codemode") {
		copy = undefined;
	} else if (heavyCmd !== undefined && heavyCmd !== "") {
		const cleanOutput = stripTerminalSequences(rawOutput);
		copy = {
			primary: heavyCmd,
			full: rawOutput !== "" ? `${heavyCmd}\n---\n${cleanOutput}` : heavyCmd,
		};
	} else if (rawOutput !== "") {
		const cleanOutput = stripTerminalSequences(rawOutput);
		const argsFormatted = formatArgsPreview(context.args);
		copy = {
			primary: cleanOutput,
			full: argsFormatted !== "" ? `${argsFormatted}\n\n${cleanOutput}` : cleanOutput,
		};
	}

	return new ToolView({
		theme,
		header: {
			title: toolName,
			status,
			summary,
		},
		railToken: toolRailToken,
		collapsedRows,
		sections,
		copy,
		outputPad: context.outputPad,
		stateHolder: context.state,
		defaultLevel,
		globalExpanded: renderOptions.expanded,
		invalidate: () => context.invalidate(),
		copyToClipboard: options?.copyToClipboard,
	});
}

/**
 * The generic frame around one owner's presentation. The caller already resolved it, so a frame
 * pass never asks the tool to rebuild its rows.
 */
function renderOwnedPresentation(params: {
	readonly toolName: string;
	readonly presentation: ToolPresentation;
	readonly result?: AgentToolResult<unknown>;
	readonly theme: Theme;
	readonly context: ToolRenderContext;
	readonly defaultLevel: FoldLevel;
	readonly options: CollapsibleToolRendererOptions | undefined;
}): ToolView {
	const { toolName, presentation, result, theme, context, defaultLevel, options } = params;
	const isError = context.isError || result?.isError === true;
	const pending = result === undefined || context.isPartial;
	const isDiff = !isError && !pending && presentation.kind === "diff";
	// The tool owns its status: a container says "none" for a child's failure and a partial patch
	// says "warn" even though the host marks the result failed. Only a provider without an opinion
	// falls back to the frame's own reading of the execution.
	const status: ToolStatusKind =
		presentation.status ??
		(isError
			? "error"
			: pending
				? context.argsComplete
					? "running"
					: "streaming"
				: isDiff
					? "none"
					: "ok");
	const railToken: RailColorToken = isError ? "error" : pending ? "accent" : "success";
	const output =
		isError && result !== undefined
			? agentResultText(result)
			: (presentation.output ?? (result === undefined ? "" : agentResultText(result)));
	const sections: RailSection[] = [...(presentation.sections ?? [])];
	if (presentation.sections === undefined && presentation.request) {
		sections.push({ railToken: "muted", content: stripTerminalSequences(presentation.request) });
	}
	if (presentation.sections !== undefined) {
		// Tool owns domain rows; this factory owns the frame and interaction only.
	} else if (isDiff) {
		if (presentation.diff.trim() !== "") {
			sections.push({
				railToken: "dim",
				content: new DiffView({
					theme,
					source: { kind: "unifiedPatch", text: presentation.diff },
				}),
			});
		}
	} else if (output !== "") {
		const lines = stripTerminalSequences(output).split("\n");
		sections.push({
			railToken,
			content: isError ? lines.map((line) => theme.fg("error", line)) : lines,
		});
	}
	const duration = result === undefined ? "" : formatDurationMs(context.durationMs);
	const summary = [stripTerminalSequences(presentation.summary), duration]
		.filter(Boolean)
		.join(" · ");
	const copy =
		presentation.copy === undefined
			? isDiff && presentation.diff.trim() !== ""
				? { primary: presentation.diff }
				: undefined
			: {
					primary: stripTerminalSequences(presentation.copy.primary),
					...(presentation.copy.full === undefined
						? {}
						: { full: stripTerminalSequences(presentation.copy.full) }),
				};
	return new ToolView({
		theme,
		header: { title: toolName, status, summary },
		railToken,
		// The tool owns the folded rows and their tones; the frame only sanitizes them for the host.
		collapsedRows:
			presentation.collapsedRows ??
			(isError && output !== ""
				? output
						.split("\n")
						.slice(0, 1)
						.map((line) => theme.fg("error", stripTerminalSequences(line)))
				: undefined),
		sections,
		copy,
		outputPad: context.outputPad,
		stateHolder: context.state,
		defaultLevel,
		globalExpanded: context.expanded,
		invalidate: () => context.invalidate(),
		copyToClipboard: options?.copyToClipboard,
	});
}

export function createCollapsibleToolRendererResolver(
	options?: CollapsibleToolRendererOptions,
): ToolRendererResolver {
	return createRendererResolver(options);
}

function createRendererResolver(
	options?: CollapsibleToolRendererOptions,
	resolvePresentation?: (toolName: string) => ToolPresentationProvider | undefined,
): ToolRendererResolver {
	const defaultLevel: FoldLevel = options?.defaultCollapsed === false ? 1 : 0;

	return (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
		const upstream = next();
		if (hasOptionalToolRenderers(upstream)) return upstream;
		const provider = getToolPresentationProvider(upstream) ?? resolvePresentation?.(toolName);
		if (provider === undefined && !shouldInterceptTool(toolName, options)) {
			return upstream;
		}

		const originalRenderCall = upstream?.renderCall;
		const originalRenderResult = upstream?.renderResult;

		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				if (provider !== undefined) {
					const callContext = { ...context, args };
					const view = renderOwnedPresentation({
						toolName,
						presentation: provider(args, undefined, theme, callContext),
						theme,
						context: callContext,
						defaultLevel,
						options,
					});
					rememberCallView(context, view);
					return view;
				}
				const isStreamingArgs = context.isPartial && !context.argsComplete;
				const status: ToolStatusKind = context.isError
					? "error"
					: toolName === "codemode"
						? "none"
						: isStreamingArgs
							? "streaming"
							: "running";

				let summary = "";
				if (isStreamingArgs) {
					const tokens = estimateStreamingTokens(args);
					summary = tokens > 0 ? `· ${String(tokens)} tokens` : "";
				} else {
					summary = extractSummaryArg(toolName, args);
					if (summary === "" && originalRenderCall !== undefined && toolName !== "codemode") {
						const upstreamLines = originalRenderCall(args, theme, context).render(120);
						const firstLine = stripTerminalSequences(upstreamLines[0] ?? "").trim();
						summary = firstLine.startsWith(toolName)
							? firstLine.slice(toolName.length).trim()
							: firstLine;
					}
				}

				const heavyCmd = extractHeavyInputCommand(toolName, args);
				const sections: RailSection[] = [];
				const inputSection = createInputCodeSection(toolName, args, theme);
				if (inputSection !== undefined) {
					sections.push(inputSection);
				} else {
					const preview = formatArgsPreview(args);
					if (preview !== "" && preview !== "{}") {
						sections.push({
							railToken: "muted",
							content: preview,
						});
					}
				}

				const copy: ToolViewCopySpec | undefined =
					heavyCmd !== undefined && heavyCmd !== ""
						? { primary: heavyCmd }
						: formatArgsPreview(args) !== ""
							? { primary: formatArgsPreview(args) }
							: undefined;

				const view = new ToolView({
					theme,
					header: {
						title: toolName,
						status,
						summary,
					},
					sections,
					copy,
					outputPad: context.outputPad,
					stateHolder: context.state,
					defaultLevel,
					globalExpanded: context.expanded,
					invalidate: () => context.invalidate(),
					copyToClipboard: options?.copyToClipboard,
				});
				rememberCallView(context, view);
				return view;
			},
			renderResult(result, renderOptions, theme, context) {
				const resultContext = {
					...context,
					expanded: renderOptions.expanded,
					isPartial: renderOptions.isPartial,
				};
				const presentation =
					provider === undefined
						? undefined
						: provider(resultContext.args, result, theme, resultContext);
				// Without an owner, a container frame is the only name-based decision left, and it
				// belongs to upstream codemode.
				const replacesCallOnPartial =
					presentation?.replaceCallOnPartial === true ||
					(presentation === undefined && SPECIALIZED_TOOL_SET.has(toolName));
				hideCallView(context, replacesCallOnPartial, renderOptions.isPartial);
				if (presentation !== undefined) {
					return renderOwnedPresentation({
						toolName,
						presentation,
						result,
						theme,
						context: resultContext,
						defaultLevel,
						options,
					});
				}

				return renderGenericResult({
					toolName,
					theme,
					context,
					result,
					renderOptions,
					defaultLevel,
					originalRenderCall,
					originalRenderResult,
					resolvePresentation,
					options,
				});
			},
		};
	};
}

/** UI factory consumed by package-owned direct renderers, independently of host resolver precedence. */
export function createOptionalToolRendererFactory(
	pi: ExtensionAPI,
	options?: CollapsibleToolRendererOptions,
): import("@hheei/pi-ext-core").ToolRendererFactory {
	return (name, native) =>
		createRendererResolver({ ...options, tools: [name] }, (toolName) =>
			getRegisteredToolPresentationProvider(pi, toolName),
		)(name, () => native) ?? native;
}

export function registerCollapsibleToolRenderer(
	pi: ExtensionAPI,
	options?: CollapsibleToolRendererOptions,
): void {
	if (typeof (pi as { on?: unknown }).on === "function") {
		pi.on("tool_execution_start", (event) => {
			recordToolExecutionStart(event);
		});
		pi.on("tool_execution_end", (event) => {
			recordToolExecutionEnd(event);
		});
		pi.on("tool_result", (event) => {
			const captured = getCapturedNestedCalls(event.toolCallId);
			if (captured && captured.length > 0) {
				const currentDetails = isRecord(event.details) ? event.details : {};
				return {
					details: {
						...currentDetails,
						__piExtUiCapturedCalls: captured,
					},
				};
			}
			return undefined;
		});
	}
	pi.registerToolRenderer(
		createRendererResolver(options, (name) => getRegisteredToolPresentationProvider(pi, name)),
	);
}
