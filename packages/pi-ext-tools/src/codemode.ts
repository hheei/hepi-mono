import {
	type AgentToolResult,
	createCodemodeExtension,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import {
	agentResultText,
	createToolTui,
	formatDuration,
	isRecord,
	type ManagedToolRegistration,
	registerManagedTool,
	type ToolCompletion,
	type ToolTui,
} from "@hheei/pi-ext-core";
import { WrappedTextBody } from "./pretty/wrapped-text.js";

const OWNER = "@hheei/pi-ext-tools";
const CODEMODE_OPTIONS_PREFIX = "// @options:";
const SCRIPT_HEADER = /^Script (?:completed|failed)\r?\nWall time [\d.]+ seconds\r?\nOutput:\r?\n/;

export interface CodemodeCallRecord {
	readonly id: string;
	readonly name: string;
	readonly args?: string;
	readonly status: "running" | "ok" | "error" | "cancelled";
	readonly durationMs?: number;
	readonly error?: string;
	readonly cost?: number;
}

export interface CodemodeToolDetails {
	readonly calls?: readonly CodemodeCallRecord[];
	readonly fullOutputPath?: string;
}

export const CODEMODE_TOOL_REGISTRATION: ManagedToolRegistration = {
	id: "codemode",
	owner: OWNER,
	exposure: "model-only",
	defaultActive: false,
};

interface CodemodeParsedOptions {
	timeout_ms?: number;
	timeout?: number;
	max_output_tokens?: number;
	target?: string;
	[key: string]: unknown;
}

function parseCodemodeOptions(args: unknown): CodemodeParsedOptions {
	const options: CodemodeParsedOptions = {};
	if (!isRecord(args)) return options;

	for (const [key, value] of Object.entries(args)) {
		if (key !== "code" && value !== undefined && value !== null) {
			options[key] = value;
		}
	}

	if (typeof args.code === "string") {
		const firstLine = args.code.split(/\r?\n/, 1)[0]?.trim() ?? "";
		if (firstLine.startsWith(CODEMODE_OPTIONS_PREFIX)) {
			try {
				const parsed = JSON.parse(firstLine.slice(CODEMODE_OPTIONS_PREFIX.length).trim());
				if (isRecord(parsed)) {
					Object.assign(options, parsed);
				}
			} catch {
				// Ignore malformed option comments
			}
		}
	}

	return options;
}

/**
 * Header facts summarizing call parameters other than the script itself.
 * Extracts options from the leading `// @options:` comment or explicit parameter overrides.
 */
export function codemodeHeaderFacts(args: unknown): string | undefined {
	const options = parseCodemodeOptions(args);
	const facts: string[] = [];

	const timeoutMs =
		typeof options.timeout_ms === "number"
			? options.timeout_ms
			: typeof options.timeout === "number"
				? options.timeout * 1000
				: undefined;

	if (timeoutMs !== undefined) {
		const label = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
		facts.push(`(timeout ${label})`);
	}

	if (typeof options.max_output_tokens === "number") {
		facts.push(`(tokens ${options.max_output_tokens})`);
	}

	if (typeof options.target === "string" && options.target !== "local") {
		facts.push(`(${options.target})`);
	}

	for (const [key, value] of Object.entries(options)) {
		if (
			key !== "timeout" &&
			key !== "timeout_ms" &&
			key !== "max_output_tokens" &&
			key !== "target" &&
			(typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		) {
			facts.push(`(${key} ${value})`);
		}
	}

	return facts.length === 0 ? undefined : facts.join(" ");
}

function cleanScriptOutput(text: string): string {
	return text.replace(SCRIPT_HEADER, "").trim();
}

class CodemodeResultBody implements Component {
	private cached: { readonly width: number; readonly rows: string[] } | undefined;

	constructor(
		private readonly lines: readonly string[],
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.rows;
		const available = Math.max(1, width);
		const truncation = this.theme.fg("dim", "…");
		const rows = this.lines.map((line) => truncateToWidth(line, available, truncation));
		this.cached = { width, rows };
		return rows;
	}

	invalidate(): void {
		this.cached = undefined;
	}
}

/** Renders the lower body of the frame containing nested tool calls and script output. */
export function renderCodemodeResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: { lastComponent?: unknown; isError?: boolean },
): Component {
	const lines: string[] = [];
	const details = isRecord(result.details) ? result.details : undefined;
	const calls: readonly CodemodeCallRecord[] = Array.isArray(details?.calls)
		? (details.calls as readonly CodemodeCallRecord[])
		: [];

	if (calls.length > 0) {
		const maxCalls = options.expanded ? calls.length : 8;
		const shownCalls = options.expanded ? calls : calls.slice(-maxCalls);
		const hiddenCalls = calls.length - shownCalls.length;

		if (hiddenCalls > 0) {
			lines.push(
				`${theme.fg("muted", `… (${hiddenCalls} earlier call${hiddenCalls === 1 ? "" : "s"},`)} ${theme.fg("dim", "ctrl+o to expand")}${theme.fg("muted", ")")}`,
			);
		}

		for (const call of shownCalls) {
			const icon =
				call.status === "ok"
					? theme.fg("success", "✓")
					: call.status === "error"
						? theme.fg("error", "✗")
						: call.status === "cancelled"
							? theme.fg("muted", "⊘")
							: theme.fg("accent", "⏳");

			const name = theme.fg("toolTitle", call.name);
			const argsText = call.args ? ` ${theme.fg("muted", call.args)}` : "";
			const duration =
				typeof call.durationMs === "number"
					? ` ${theme.fg("dim", formatDuration(call.durationMs) ?? `${call.durationMs}ms`)}`
					: "";
			const cost =
				typeof call.cost === "number"
					? ` ${theme.fg("dim", `$${call.cost >= 0.01 ? call.cost.toFixed(2) : call.cost.toPrecision(2)}`)}`
					: "";

			lines.push(`${icon} ${name}${argsText}${duration}${cost}`);

			if (call.error && (options.expanded || call.status === "error")) {
				for (const el of call.error.split(/\r?\n/)) {
					lines.push(`    ${theme.fg("error", el)}`);
				}
			}
		}
	}

	const imageCount = Array.isArray(result.content)
		? result.content.filter((item) => isRecord(item) && item.type === "image").length
		: 0;
	if (imageCount > 0) {
		if (lines.length > 0) {
			lines.push("");
		}
		lines.push(theme.fg("accent", `[${imageCount} image${imageCount === 1 ? "" : "s"} attached]`));
	}

	const rawText = agentResultText(result);
	const cleanOutput = cleanScriptOutput(rawText);

	if (cleanOutput !== "") {
		if (lines.length > 0) {
			lines.push("");
		}

		const outputLines = cleanOutput.split(/\r?\n/);
		const maxOutputLines = options.expanded ? outputLines.length : 12;
		const shownOutput = options.expanded ? outputLines : outputLines.slice(0, maxOutputLines);
		const hiddenOutput = outputLines.length - shownOutput.length;

		const textColor = context.isError ? "error" : "toolOutput";
		for (const ol of shownOutput) {
			lines.push(theme.fg(textColor, ol));
		}

		if (hiddenOutput > 0) {
			lines.push(
				`${theme.fg("muted", `… (${hiddenOutput} more line${hiddenOutput === 1 ? "" : "s"},`)} ${theme.fg("dim", "ctrl+o to expand")}${theme.fg("muted", ")")}`,
			);
		}

		if (typeof details?.fullOutputPath === "string" && !options.expanded) {
			lines.push(theme.fg("dim", `Full output: ${details.fullOutputPath}`));
		}
	}

	if (lines.length === 0 && context.isError) {
		lines.push(theme.fg("error", "Script failed"));
	}

	return new CodemodeResultBody(lines, theme);
}

/** Formats the footer row showing ok/failed call counts and total execution duration. */
export function codemodeFooter(
	result: AgentToolResult<unknown>,
	completion: ToolCompletion | undefined,
): string {
	const details = isRecord(result.details) ? result.details : undefined;
	const calls: readonly CodemodeCallRecord[] = Array.isArray(details?.calls)
		? (details.calls as readonly CodemodeCallRecord[])
		: [];

	const parts: string[] = [];
	const duration =
		formatDuration(completion?.durationMs) ??
		(typeof completion?.durationMs === "number" ? `${completion.durationMs}ms` : undefined);

	if (calls.length > 0) {
		const okCount = calls.filter((c) => c.status === "ok").length;
		const errorCount = calls.filter((c) => c.status === "error").length;
		const cancelledCount = calls.filter((c) => c.status === "cancelled").length;
		const failedCount = errorCount + cancelledCount;

		if (failedCount > 0) {
			parts.push(`${okCount} ok`, `${failedCount} failed`);
		} else {
			parts.push(`${okCount} ok`);
		}
	} else if (result.isError) {
		parts.push("failed");
	}

	if (duration !== undefined) {
		parts.push(duration);
	} else {
		parts.push("completed");
	}

	const totalCost = calls.reduce((sum, call) => sum + (call.cost ?? 0), 0);
	if (totalCost > 0) {
		parts.push(`$${totalCost >= 0.01 ? totalCost.toFixed(2) : totalCost.toPrecision(2)}`);
	}

	return parts.join(" · ");
}

export function codemodeWarning(result: AgentToolResult<unknown>): boolean {
	if (result.isError) return true;
	if (!isRecord(result.details)) return false;
	const calls = result.details.calls;
	if (Array.isArray(calls)) {
		return calls.some(
			(call) => isRecord(call) && (call.status === "error" || call.status === "cancelled"),
		);
	}
	return false;
}

/** Captures upstream's ToolDefinition to preserve identical QuickJS execution, loadout, and sampling. */
export function createUnderlyingCodemodeTool(pi: ExtensionAPI): ToolDefinition {
	let captured: ToolDefinition | undefined;
	const factory = createCodemodeExtension();
	factory({
		registerTool(tool: ToolDefinition) {
			captured = tool;
		},
		appendEntry: (customType: string, data: unknown) => {
			pi.appendEntry?.(customType, data);
		},
		getAllTools: () => pi.getAllTools?.() ?? [],
		getSettings: () => pi.getSettings?.() ?? {},
	} as unknown as ExtensionAPI);

	if (captured === undefined) {
		throw new Error("createCodemodeExtension did not register a tool definition");
	}
	return captured;
}

/** Registers codemode with pi-ext-tools canonical ownership and framed bash-like UI. */
export function registerCodemodeTool(
	pi: ExtensionAPI,
	tui: ToolTui = createToolTui(),
): ToolDefinition {
	const baseTool = createUnderlyingCodemodeTool(pi);

	const toolWithCustomResult: ToolDefinition = {
		...baseTool,
		description: `${baseTool.description}\nDo not write any comments in the code. Write only executable code.`,
		promptGuidelines: [
			...(baseTool.promptGuidelines ?? []),
			"codemode: do not write any comments in the code. Write only executable code.",
		],
		renderResult: (result, options, theme, context) =>
			renderCodemodeResult(result, options, theme, context),
	};

	const framed = tui.frame(toolWithCustomResult, {
		summary: () => "",
		suffix: codemodeHeaderFacts,
		headerLine: "truncate",
		longOutput: true,
		maxBodyLines: 20,
		request: (args, theme) => {
			const code = isRecord(args) && typeof args.code === "string" ? args.code : "";
			return code === "" ? undefined : new WrappedTextBody(stripTerminalSequences(code), theme);
		},
		footer: (result, completion, options) =>
			options.isPartial ? undefined : codemodeFooter(result, completion),
		warning: codemodeWarning,
	});

	registerManagedTool(pi, CODEMODE_TOOL_REGISTRATION, framed);
	return framed;
}
