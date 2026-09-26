import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	type AgentToolResult,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	createToolTui,
	DEFAULT_MAX_BODY_LINES,
	registerManagedLoadoutTool,
	type ToolCompletion,
	type ToolTui,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { BashOutputSink } from "./bash-output.js";
import { counted } from "./counted.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { isTargetError, LOCAL_TARGET, type TargetRuntime } from "./targets.js";
import { startBashTask } from "./tasks/bash-task.js";

const OWNER = "@hheei/pi-ext-tools";
const BASH_DESCRIPTION = "Run one shell command or short pipeline.";
const BASH_PROMPT_SNIPPET = "Run one shell command or short pipeline.";
const BASH_PROMPT_GUIDELINES = [
	"Use `async` only for finite commands that may outlive this tool call; its result is added to the context when it finishes.",
	"Do not poll background tasks. Use `wait_tasks` only when the next step needs their results.",
	"Remote `target` is an authorized SSH host; omit async. Working directory is the remote home.",
] as const;
const BASH_TIMEOUT_DESCRIPTION = "Timeout in seconds (optional, no default timeout)";
const Timeout = Type.Optional(Type.Number({ description: BASH_TIMEOUT_DESCRIPTION }));
const Target = Type.Optional(
	Type.String({
		description: "Execution target: local or an authorized SSH host; ",
	}),
);
const BashInput = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		timeout: Timeout,
		async: Type.Optional(Type.Boolean({ description: "Run the command as a background job." })),
		target: Target,
	},
	{ additionalProperties: false },
);
type Input = Static<typeof BashInput>;

function normalizeBashInput(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const input = { ...(value as Record<string, unknown>) };
	if (input.timeout === null) delete input.timeout;
	if (input.async === null) delete input.async;
	if (input.target === null) delete input.target;
	return input;
}

interface BashToolResult {
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly details: Record<string, unknown>;
}

function detailsRecord(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function lineCount(text: string): number {
	if (text === "") return 0;
	return text.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

function bashFooter(
	result: AgentToolResult<unknown>,
	completion: ToolCompletion | undefined,
): string {
	const details = detailsRecord(result.details);
	const output =
		typeof details.output === "string"
			? details.output
			: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	const exitCode = typeof details.exitCode === "number" ? details.exitCode : "?";
	const lines =
		typeof details.totalLines === "number" && Number.isFinite(details.totalLines)
			? details.totalLines
			: lineCount(output);
	const duration =
		completion?.durationMs === undefined
			? "completed"
			: completion.durationMs < 1_000
				? `${completion.durationMs}ms`
				: `${(completion.durationMs / 1_000).toFixed(1)}s`;
	return `exit ${exitCode} · ${counted(lines, "line")} · ${duration}`;
}

function logicalOutputLines(output: string): string[] {
	if (output === "") return [];
	return output
		.replace(/\r?\n$/, "")
		.split("\n")
		.map((line) => line.replace(/\r/g, ""));
}

function outputTotalLines(result: AgentToolResult<unknown>, output: string): number {
	const details = detailsRecord(result.details);
	return typeof details.totalLines === "number" && Number.isFinite(details.totalLines)
		? details.totalLines
		: lineCount(output);
}

function outputText(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function bashBodyLine(theme: Theme, line: string): string {
	const stripped = stripTerminalSequences(line);
	const dimmed = theme.fg("dim", stripped);
	return theme.fg("text", stripped) === dimmed ? dimmed : stripped;
}

class BashOutputBody implements Component {
	private cached: { readonly width: number; readonly rows: string[] } | undefined;

	constructor(
		private readonly source: Component,
		private readonly output: string,
		private readonly theme: Theme,
		private readonly expanded: boolean,
		private readonly totalLines: number,
	) {}

	sourceComponent(): Component {
		return this.source;
	}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.rows;
		const lines = logicalOutputLines(this.output);
		if (lines.length === 0) return [];
		const available = Math.max(1, width);
		const truncation = this.theme.fg("dim", "…");
		const budget = this.expanded ? lines.length : DEFAULT_MAX_BODY_LINES;
		const hiddenTotal = Math.max(this.totalLines, lines.length);
		const needsHint = !this.expanded && hiddenTotal > budget;
		const take = needsHint ? Math.min(lines.length, budget - 1) : Math.min(lines.length, budget);
		const visible = lines.slice(-take);
		const hidden = hiddenTotal - visible.length;
		const rows = visible.map((line) =>
			truncateToWidth(bashBodyLine(this.theme, line), available, truncation),
		);
		if (!needsHint) {
			this.cached = { width, rows };
			return rows;
		}
		const hint = this.theme.fg("dim", `… (${hidden} earlier lines, ctrl+o to expand)`);
		const cached = [truncateToWidth(hint, available, truncation), ...rows];
		this.cached = { width, rows: cached };
		return cached;
	}

	invalidate(): void {
		this.source.invalidate();
	}
}

function result(text: string, details: Record<string, unknown> = {}): BashToolResult {
	return { content: [{ type: "text" as const, text }], details };
}

async function runForeground(
	command: string,
	context: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	shellPath: string,
	timeoutSeconds: number | undefined,
	tailBytes: number,
): Promise<BashToolResult> {
	if (signal?.aborted) return result("Bash aborted", { error: "aborted" });
	const sink = new BashOutputSink({ tailBytes });
	const update = (data: Buffer): void => {
		sink.push(data);
		const output = sink.snapshot();
		onUpdate?.({ content: [{ type: "text", text: output.output }], details: output });
	};
	let exitCode: number | null;
	let timedOut = false;
	try {
		exitCode = (
			await createLocalBashOperations({ shellPath }).exec(command, context.cwd, {
				onData: update,
				...(signal === undefined ? {} : { signal }),
				...(timeoutSeconds === undefined ? {} : { timeout: timeoutSeconds }),
			})
		).exitCode;
	} catch (error) {
		if (signal?.aborted) return result("Bash aborted", { error: "aborted" });
		if (!(error instanceof Error) || !error.message.startsWith("timeout:")) throw error;
		timedOut = true;
		exitCode = null;
	}
	const output = sink.finish();
	return result(output.output, {
		...output,
		...(timedOut ? { timedOut: true } : {}),
		exitCode,
	});
}

function bashResultWarning(result: { readonly details: unknown }): boolean {
	if (typeof result.details !== "object" || result.details === null) return false;
	const details = result.details as Record<string, unknown>;
	return (
		details.timedOut === true || (typeof details.exitCode === "number" && details.exitCode !== 0)
	);
}

function isRemoteBashTarget(target: unknown): target is string {
	return typeof target === "string" && target !== LOCAL_TARGET;
}

async function runRemoteBash(
	target: string,
	command: string,
	runtime: TargetRuntime,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	timeoutSeconds: number | undefined,
	tailBytes: number,
): Promise<BashToolResult> {
	if (signal?.aborted) return result("Bash aborted", { error: "aborted", target });
	const sink = new BashOutputSink({ tailBytes });
	try {
		const { code, timedOut } = await runtime.exec(target, command, {
			...(signal === undefined ? {} : { signal }),
			...(timeoutSeconds === undefined || timeoutSeconds <= 0
				? {}
				: { timeoutMs: timeoutSeconds * 1000 }),
			onData: (data) => {
				sink.push(data);
				const output = sink.snapshot();
				onUpdate?.({ content: [{ type: "text", text: output.output }], details: output });
			},
		});
		const output = sink.finish();
		return result(output.output, {
			...output,
			...(timedOut ? { timedOut: true } : {}),
			exitCode: code,
			target,
			outcome: timedOut ? "timeout" : "ok",
		});
	} catch (error) {
		const output = sink.finish();
		if (isTargetError(error)) {
			const aborted = error.outcome === "cancelled";
			return result(aborted ? "Bash aborted" : error.message, {
				...output,
				error: aborted ? "aborted" : error.outcome,
				outcome: error.outcome,
				target,
			});
		}
		throw error;
	}
}

/** Pi original definition remains default execution; async is extension-owned and session-scoped. */
export function registerBashTool(
	pi: ExtensionAPI,
	state?: FffRuntimeState,
	tui: ToolTui = createToolTui(),
): ToolDefinition {
	const {
		renderCall: _upstreamRenderCall,
		renderResult: upstreamRenderResult,
		...template
	} = createBashToolDefinition(process.cwd());
	type UpstreamRenderResult = NonNullable<typeof upstreamRenderResult>;
	const tool = {
		...template,
		description: BASH_DESCRIPTION,
		promptSnippet: BASH_PROMPT_SNIPPET,
		promptGuidelines: BASH_PROMPT_GUIDELINES,
		parameters: BashInput,
		renderResult(
			result: Parameters<UpstreamRenderResult>[0],
			options: Parameters<UpstreamRenderResult>[1],
			theme: Parameters<UpstreamRenderResult>[2],
			context: Parameters<UpstreamRenderResult>[3],
		) {
			const previous =
				context.lastComponent instanceof BashOutputBody
					? context.lastComponent.sourceComponent()
					: context.lastComponent;
			const output = outputText(result);
			const source =
				upstreamRenderResult?.(result, options, theme, {
					...context,
					lastComponent: previous,
				}) ?? new Text("", 0, 0);
			return new BashOutputBody(
				source,
				output,
				theme,
				options.expanded,
				outputTotalLines(result, output),
			);
		},
		async execute(
			_id: string,
			params: Input,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			context: ExtensionContext,
		) {
			const normalizedParams = normalizeBashInput(params);
			if (!Value.Check(BashInput, normalizedParams)) throw new Error("Invalid bash parameters");
			const validatedParams = normalizedParams;
			if (isRemoteBashTarget(validatedParams.target)) {
				if ("async" in validatedParams && validatedParams.async === true)
					return result("Async Bash is local-only; omit async for SSH targets.", {
						error: "async_unsupported",
						target: validatedParams.target,
					});
				const runtime = state?.getTargetRuntime();
				if (runtime === undefined) throw new Error("Target runtime is unavailable.");
				return runRemoteBash(
					validatedParams.target,
					validatedParams.command,
					runtime,
					signal,
					onUpdate,
					validatedParams.timeout,
					(state?.getSettings().bashOutputTailKiB ?? 10) * 1024,
				);
			}
			if ("async" in validatedParams && validatedParams.async === true) {
				const tasks = state?.getTasks();
				const jobs = state?.getBashJobs();
				if (tasks === undefined || jobs === undefined)
					return result("Async Bash unavailable outside active session", {
						error: "session_unavailable",
					});
				try {
					const task = startBashTask({
						tasks,
						jobs,
						command: validatedParams.command,
						cwd: context.cwd,
						shellPath: state?.getSettings().shellPath ?? process.env.SHELL ?? "/bin/sh",
						...(validatedParams.timeout === undefined
							? {}
							: { timeoutMs: Math.max(0, validatedParams.timeout * 1000) }),
					});
					return result(
						`Started background task ${task.id}. Its result is added to the context when it finishes; use wait_tasks only if the next step needs it now.`,
						{
							taskId: task.id,
							type: task.type,
							status: task.status,
							purpose: task.purpose,
						},
					);
				} catch (error) {
					return result(
						`Unable to start Bash job: ${error instanceof Error ? error.message : String(error)}`,
						{ error: "start_failed" },
					);
				}
			}
			return runForeground(
				validatedParams.command,
				context,
				signal,
				onUpdate,
				state?.getSettings().shellPath ?? process.env.SHELL ?? "/bin/sh",
				validatedParams.timeout,
				(state?.getSettings().bashOutputTailKiB ?? 10) * 1024,
			);
		},
	} as unknown as ToolDefinition<typeof BashInput, unknown, unknown>;
	registerManagedLoadoutTool(
		pi,
		{
			id: "bash",
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tui.frame(tool, {
			maxBodyLines: Number.POSITIVE_INFINITY,
			footer: (result, completion, options) =>
				options.isPartial ? undefined : bashFooter(result, completion),
			warning: bashResultWarning,
		}),
	);
	return tool;
}

export { BashInput };
