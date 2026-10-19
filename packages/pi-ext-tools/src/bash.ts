import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	type AgentToolResult,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ToolDefinition,
	type ToolLoadout,
	type ToolLoadoutChanges,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import {
	agentResultText,
	errorMessage,
	formatDuration,
	isRecord,
	textToolResult,
} from "@hheei/pi-ext-core";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type BashJobRegistry, type BashJobSnapshot, defaultShellPath } from "./bash-jobs.js";
import { BashOutputSink } from "./bash-output.js";
import { isSearchOnlyCommand, SEARCH_BASH_TIMEOUT_SECONDS } from "./bash-search.js";
import type { ToolsRuntimeState } from "./session-state.js";

/** Unexpanded output rows. Matches the request cap so a command and its output weigh the same. */
const BASH_MAX_BODY_LINES = 10;

const BASH_DESCRIPTION = "Run one shell command or short pipeline in the foreground.";
const BASH_TIMEOUT_DESCRIPTION =
	"Timeout in seconds (optional, default 180s, or 25s for pure search commands like rg/fd/grep/find)";
const Timeout = Type.Optional(Type.Number({ description: BASH_TIMEOUT_DESCRIPTION }));
const BashInput = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		timeout: Timeout,
	},
	{ additionalProperties: false },
);
type Input = Static<typeof BashInput>;

function normalizeBashInput(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const input = { ...(value as Record<string, unknown>) };
	if (input.timeout === null) delete input.timeout;
	return input;
}

/** Every bash result carries the model-visible text plus tool-owned details. */
type BashToolResult = AgentToolResult<Record<string, unknown>>;

function detailsRecord(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : {};
}

function logicalOutputLines(output: string): string[] {
	if (output === "") return [];
	return output
		.replace(/\r?\n$/, "")
		.split("\n")
		.map((line) => line.replace(/\r/g, ""));
}

function outputTotalLines(result: AgentToolResult<unknown>, output: string): number {
	const total = detailsRecord(result.details).totalLines;
	if (typeof total === "number" && Number.isFinite(total)) return total;
	return output === "" ? 0 : output.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/** Matches upstream bashOutputSchema in @earendil-works/pi-coding-agent */
export interface BashToolOutput {
	output: string;
	truncated: boolean;
	exit_code: number;
	wall_time_seconds: number;
}

function withBashStructuredContent(
	result: AgentToolResult<unknown>,
	options: {
		output: string;
		truncated: boolean;
		exitCode: number;
		startedAt: number;
	},
): AgentToolResult<unknown> {
	const wallTimeSeconds = Math.round((performance.now() - options.startedAt) / 100) / 10;
	const structuredContent: BashToolOutput = {
		output: options.output,
		truncated: options.truncated,
		exit_code: options.exitCode,
		wall_time_seconds: wallTimeSeconds,
	};
	return {
		...result,
		structuredContent: structuredContent as never,
		...(options.exitCode !== 0 ? { isError: true } : {}),
	};
}

/**
 * The text a failed call shows the model. Providers send only a tool result's text parts, so the
 * reason has to live here rather than in details, with whatever partial output the command produced
 * above it, the way upstream bash reports a failure.
 */
function bashFailureText(reason: string, output: string): string {
	const body = output.trimEnd();
	return body === "" ? reason : `${body}\n\n${reason}`;
}

/**
 * One cancelled call: partial output, the reason, and how long the command ran. `startedAt` is
 * omitted when the signal was already aborted before the command started, because "aborted after
 * 0ms" describes nothing the model can use.
 */
function bashAbortedResult(options: {
	output: string;
	startedAt?: number;
	truncated?: boolean;
}): BashToolResult {
	const elapsed =
		options.startedAt === undefined
			? undefined
			: formatDuration(performance.now() - options.startedAt);
	const text = bashFailureText(
		elapsed === undefined ? "Bash aborted" : `Bash aborted after ${elapsed}`,
		options.output,
	);
	return withBashStructuredContent(
		textToolResult(text, {
			output: options.output,
			truncated: options.truncated ?? false,
			error: "aborted",
		}),
		{
			output: options.output,
			truncated: options.truncated ?? false,
			exitCode: 130,
			startedAt: options.startedAt ?? performance.now(),
		},
	) as BashToolResult;
}

/**
 * A command killed by its own timeout. The line names the budget that expired, which is what the
 * model needs to choose a longer one or a narrower command, so the elapsed time would only repeat
 * the same number back.
 */
function bashTimedOutResult(options: {
	output: string;
	startedAt: number;
	timeoutSeconds: number;
	truncated: boolean;
}): BashToolResult {
	const text = bashFailureText(
		`Command timed out after ${options.timeoutSeconds}s`,
		options.output,
	);
	return withBashStructuredContent(
		textToolResult(text, {
			output: options.output,
			truncated: options.truncated,
			timedOut: true,
			exitCode: 124,
			outcome: "timeout",
		}),
		{
			output: options.output,
			truncated: options.truncated,
			exitCode: 124,
			startedAt: options.startedAt,
		},
	) as BashToolResult;
}

function outputStreamer(
	sink: BashOutputSink,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): (data: Buffer) => void {
	return (data) => {
		sink.push(data);
		const output = sink.snapshot();
		onUpdate?.(textToolResult(output.output, output));
	};
}

/**
 * Bash's own result body. The result text is already exactly what the model sees, so the body
 * renders it directly and caps it to the shared collapsed height instead of delegating to a second
 * upstream presentation of the same text.
 */
class BashOutputBody implements Component {
	private cached: { readonly width: number; readonly rows: string[] } | undefined;

	constructor(
		private readonly output: string,
		private readonly theme: Theme,
		private readonly expanded: boolean,
		private readonly totalLines: number,
		private readonly isError: boolean,
		private readonly durationMs: number | undefined,
	) {}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.rows;
		const lines = logicalOutputLines(this.output);
		const available = Math.max(1, width);
		const truncation = this.theme.fg("dim", "…");
		const style = this.isError ? "error" : "toolOutput";
		const budget = this.expanded ? lines.length : BASH_MAX_BODY_LINES;
		const hiddenTotal = Math.max(this.totalLines, lines.length);
		const needsHint = !this.expanded && hiddenTotal > budget;
		const take = needsHint ? Math.min(lines.length, budget - 1) : Math.min(lines.length, budget);
		const visible = lines.slice(-take);
		const hidden = hiddenTotal - visible.length;
		const body = visible.map((line) =>
			this.theme.fg(style, truncateToWidth(stripTerminalSequences(line), available, truncation)),
		);
		// Pi measures the duration of a finished call; live progress has none yet.
		const elapsed = formatDuration(this.durationMs);
		const footer = elapsed === undefined ? undefined : this.theme.fg("dim", `Took ${elapsed}`);
		const hint =
			needsHint && body.length > 0
				? [
						truncateToWidth(
							this.theme.fg("dim", `… (${hidden} earlier lines, ctrl+o to expand)`),
							available,
							truncation,
						),
					]
				: [];
		const rows = [...hint, ...body, ...(footer === undefined ? [] : [footer])];
		this.cached = { width, rows };
		return rows;
	}

	invalidate(): void {
		this.cached = undefined;
	}
}

const DEFAULT_BASH_TIMEOUT_SECONDS = 180;

export function resolveDefaultBashTimeout(command: string): number {
	return isSearchOnlyCommand(command) ? SEARCH_BASH_TIMEOUT_SECONDS : DEFAULT_BASH_TIMEOUT_SECONDS;
}

async function runForeground(
	command: string,
	context: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	shellPath: string,
	timeoutSeconds: number | undefined,
	tailBytes: number,
	jobs?: BashJobRegistry | undefined,
): Promise<BashToolResult> {
	const startedAt = performance.now();
	const effectiveTimeout = timeoutSeconds ?? resolveDefaultBashTimeout(command);
	if (signal?.aborted) return Promise.resolve(bashAbortedResult({ output: "" }));
	const sink = new BashOutputSink(tailBytes);
	const update = outputStreamer(sink, onUpdate);

	if (jobs === undefined) {
		let exitCode: number | null;
		let timedOut = false;
		try {
			exitCode = (
				await createLocalBashOperations({ shellPath }).exec(command, context.cwd, {
					onData: update,
					...(signal === undefined ? {} : { signal }),
					timeout: effectiveTimeout,
				})
			).exitCode;
		} catch (error) {
			if (signal?.aborted)
				return bashAbortedResult({
					output: sink.finish().output,
					startedAt,
					truncated: sink.finish().truncated,
				});
			if (!(error instanceof Error) || !error.message.startsWith("timeout:")) throw error;
			timedOut = true;
			exitCode = null;
		}
		const output = sink.finish();
		if (timedOut)
			return bashTimedOutResult({
				output: output.output,
				truncated: output.truncated,
				startedAt,
				timeoutSeconds: effectiveTimeout,
			});
		const finalExitCode = exitCode ?? 0;
		const result = textToolResult(output.output, {
			...output,
			...(timedOut ? { timedOut: true } : {}),
			exitCode: finalExitCode,
		});
		return withBashStructuredContent(result, {
			output: output.output,
			truncated: output.truncated,
			exitCode: finalExitCode,
			startedAt,
		}) as BashToolResult;
	}

	let streaming = true;
	const onData = (data: Buffer): void => {
		if (streaming) update(data);
	};
	let job: BashJobSnapshot;
	try {
		job = jobs.start({
			command,
			cwd: context.cwd,
			shellPath,
			timeoutMs: Math.max(0, effectiveTimeout * 1000),
			onData,
		});
	} catch (error) {
		const output = sink.finish();
		const result = textToolResult(`Unable to start bash job: ${errorMessage(error)}`, {
			...output,
			error: "start_failed",
		});
		return withBashStructuredContent(result, {
			output: output.output || errorMessage(error),
			truncated: output.truncated,
			exitCode: 1,
			startedAt,
		}) as BashToolResult;
	}

	return new Promise<BashToolResult>((resolve) => {
		let settled = false;
		// The wait itself is cancelled with the call, so an aborted foreground command never
		// leaves a waiter behind on a record only this call was reading.
		const watcher = new AbortController();

		const cleanup = (): void => {
			streaming = false;
			signal?.removeEventListener("abort", onAbort);
			watcher.abort();
		};

		const finishForeground = (jobSnapshot: BashJobSnapshot): void => {
			if (settled) return;
			settled = true;
			cleanup();
			const output = sink.finish();
			const timedOut = jobSnapshot.timedOut;
			if (timedOut) {
				resolve(
					bashTimedOutResult({
						output: output.output,
						truncated: output.truncated,
						startedAt,
						timeoutSeconds: effectiveTimeout,
					}),
				);
				return;
			}
			const isFailed = jobSnapshot.status === "failed";
			const exitCode = jobSnapshot.exitCode ?? (isFailed ? 127 : 0);
			const isError = isFailed || exitCode !== 0;
			const result = textToolResult(output.output, {
				...output,
				exitCode,
				...(isError ? { isError: true } : {}),
			});
			resolve(
				withBashStructuredContent(result, {
					output: output.output,
					truncated: output.truncated,
					exitCode,
					startedAt,
				}) as BashToolResult,
			);
		};

		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			jobs.stop(job.id);
			const output = sink.finish();
			resolve(
				bashAbortedResult({
					output: output.output,
					startedAt,
					truncated: output.truncated,
				}),
			);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		void jobs.waitFor(job.id, watcher.signal).then((finalSnapshot) => {
			if (finalSnapshot) finishForeground(finalSnapshot);
		});
	});
}

export function registerBashTool(pi: ExtensionAPI, state?: ToolsRuntimeState): ToolDefinition {
	const {
		renderCall: _renderCall,
		renderResult: _renderResult,
		...template
	} = createBashToolDefinition(process.cwd());
	const tool = {
		...template,
		description: BASH_DESCRIPTION,
		promptSnippet: BASH_DESCRIPTION,
		parameters: BashInput,
		annotations: {
			openWorldHint: true,
			destructiveHint: true,
		},
		prepareLoadout(loadout: ToolLoadout): ToolLoadoutChanges {
			const declared = new Set(loadout.declared.map((t) => t.name));
			const hasEval = declared.has("python_eval");
			const hasCodemode = declared.has("codemode");
			if (hasEval && hasCodemode) {
				return {
					descriptions: {
						bash: `${BASH_DESCRIPTION} Prefer python_eval for persistent Python computation, and codemode for tool orchestration or filtering.`,
					},
				};
			}
			if (hasEval) {
				return {
					descriptions: {
						bash: `${BASH_DESCRIPTION} Prefer python_eval over python -c for multi-step computation.`,
					},
				};
			}
			if (hasCodemode) {
				return {
					descriptions: {
						bash: `${BASH_DESCRIPTION} Prefer codemode over complex shell loops or pipeline filtering.`,
					},
				};
			}
			return {};
		},
		renderResult(
			result: AgentToolResult<unknown>,
			options: { readonly expanded: boolean; readonly isPartial: boolean },
			theme: Theme,
			context: { readonly durationMs?: number | undefined },
		) {
			const output = agentResultText(result);
			return new BashOutputBody(
				output,
				theme,
				options.expanded,
				outputTotalLines(result, output),
				result.isError === true,
				context.durationMs,
			);
		},
		async execute(
			_id: string,
			params: Input,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			context: ExtensionContext,
		) {
			const validatedParams = normalizeBashInput(params);
			if (!Value.Check(BashInput, validatedParams)) throw new Error("Invalid bash parameters");
			const settings = state?.getSettings();

			const jobs = state?.getBashJobs();
			return runForeground(
				validatedParams.command,
				context,
				signal,
				onUpdate,
				settings?.shellPath ?? defaultShellPath(),
				validatedParams.timeout,
				(settings?.bashOutputTailKiB ?? 10) * 1024,
				jobs,
			);
		},
	} as unknown as ToolDefinition<typeof BashInput, unknown, unknown>;
	pi.registerTool(tool);

	return tool;
}

export { BashInput, isSearchOnlyCommand, SEARCH_BASH_TIMEOUT_SECONDS, Timeout };
