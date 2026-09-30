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
	agentResultText,
	createToolTui,
	errorMessage,
	formatDuration,
	isRecord,
	registerManagedTool,
	type TaskRegistry,
	type TaskSnapshot,
	type ToolCompletion,
	type ToolTui,
	textToolResult,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type BashJobRegistry, type BashJobSnapshot, defaultShellPath } from "./bash-jobs.js";
import { BashOutputSink } from "./bash-output.js";
import { counted } from "./counted.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { DEFAULT_FFF_SETTINGS } from "./fff/settings.js";
import { WrappedTextBody } from "./pretty/wrapped-text.js";
import { isTargetError, LOCAL_TARGET, type TargetRuntime } from "./targets.js";
import { promoteBashJobToTask, startBashTask } from "./tasks/bash-task.js";

/** Unexpanded output rows. Matches the request cap so a command and its output weigh the same. */
const BASH_MAX_BODY_LINES = 10;

const OWNER = "@hheei/pi-ext-tools";
const BASH_DESCRIPTION = "Run one shell command or short pipeline.";
const BASH_PROMPT_GUIDELINES = [
	"Use `blocking: false` only for finite commands that may outlive this tool call. Work on other tasks while it runs; once hands-on work is complete, call `wait_tasks` to wait for any unfinished background tasks.",
	"Local commands without timeout transition to background tasks (e.g. bash-1) after 60s unless `blocking: true` is passed. After completing immediate work, wait for them with `wait_tasks`.",
	"Remote `target` is an authorized SSH host and always runs in the foreground.",
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
		blocking: Type.Optional(
			Type.Boolean({
				description:
					"Wait for completion instead of returning immediately. Pass false to run in background; use wait_tasks once hands-on work is complete to wait for it.",
			}),
		),
		target: Target,
	},
	{ additionalProperties: false },
);
type Input = Static<typeof BashInput>;

function normalizeBashInput(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const input = { ...(value as Record<string, unknown>) };
	if (input.timeout === null) delete input.timeout;
	if (input.blocking === null) delete input.blocking;
	if (input.target === null) delete input.target;
	return input;
}

/**
 * Branch marker for a task that starts from a tool call. `undefined` when the session has no
 * entry yet, which the delivery adapter treats as always deliverable.
 */
function taskAnchor(context: ExtensionContext): string | undefined {
	return context.sessionManager?.getLeafId?.() ?? undefined;
}

/** Every bash result carries the model-visible text plus tool-owned details. */
type BashToolResult = AgentToolResult<Record<string, unknown>>;

function detailsRecord(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : {};
}

function bashFooter(
	result: AgentToolResult<unknown>,
	completion: ToolCompletion | undefined,
): string {
	const details = detailsRecord(result.details);
	if (details.autoAsyncTransition === true && typeof details.taskId === "string") {
		return `transitioned to ${details.taskId} · running in background · ${details.elapsedSeconds ?? 60}s`;
	}
	if (typeof details.taskId === "string") {
		return `task ${details.taskId} · background`;
	}
	const output = typeof details.output === "string" ? details.output : agentResultText(result);
	const exitCode = typeof details.exitCode === "number" ? details.exitCode : "?";
	const lines = outputTotalLines(result, output);
	const duration = formatDuration(completion?.durationMs) ?? "completed";
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
	const total = detailsRecord(result.details).totalLines;
	if (typeof total === "number" && Number.isFinite(total)) return total;
	return output === "" ? 0 : output.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/** Matches upstream bashOutputSchema in @earendil-works/pi-coding-agent */
export interface BashToolOutput {
	output: string;
	truncated: boolean;
	full_output_path?: string;
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
		fullOutputPath?: string;
	},
): AgentToolResult<unknown> {
	const wallTimeSeconds = Math.round((performance.now() - options.startedAt) / 100) / 10;
	const structuredContent: BashToolOutput = {
		output: options.output,
		truncated: options.truncated,
		...(options.fullOutputPath !== undefined ? { full_output_path: options.fullOutputPath } : {}),
		exit_code: options.exitCode,
		wall_time_seconds: wallTimeSeconds,
	};
	return {
		...result,
		structuredContent: structuredContent as never,
		...(options.exitCode !== 0 ? { isError: true } : {}),
	};
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
		const budget = this.expanded ? lines.length : BASH_MAX_BODY_LINES;
		const hiddenTotal = Math.max(this.totalLines, lines.length);
		const needsHint = !this.expanded && hiddenTotal > budget;
		const take = needsHint ? Math.min(lines.length, budget - 1) : Math.min(lines.length, budget);
		const visible = lines.slice(-take);
		const hidden = hiddenTotal - visible.length;
		const rows = visible.map((line) =>
			truncateToWidth(stripTerminalSequences(line), available, truncation),
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

async function runForeground(
	command: string,
	context: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	shellPath: string,
	timeoutSeconds: number | undefined,
	tailBytes: number,
	anchor: string | undefined,
	jobs?: BashJobRegistry | undefined,
	tasks?: TaskRegistry | undefined,
	autoAsyncSeconds = 60,
): Promise<BashToolResult> {
	const startedAt = performance.now();
	if (signal?.aborted)
		return Promise.resolve(
			withBashStructuredContent(textToolResult("Bash aborted", { error: "aborted" }), {
				output: "Bash aborted",
				truncated: false,
				exitCode: 130,
				startedAt,
			}) as BashToolResult,
		);
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
					...(timeoutSeconds === undefined ? {} : { timeout: timeoutSeconds }),
				})
			).exitCode;
		} catch (error) {
			if (signal?.aborted)
				return withBashStructuredContent(textToolResult("Bash aborted", { error: "aborted" }), {
					output: "Bash aborted",
					truncated: false,
					exitCode: 130,
					startedAt,
				}) as BashToolResult;
			if (!(error instanceof Error) || !error.message.startsWith("timeout:")) throw error;
			timedOut = true;
			exitCode = null;
		}
		const output = sink.finish();
		const finalExitCode = exitCode ?? (timedOut ? 124 : 0);
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

	const shouldAutoAsync =
		timeoutSeconds === undefined && tasks !== undefined && autoAsyncSeconds > 0;
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
			...(timeoutSeconds === undefined ? {} : { timeoutMs: Math.max(0, timeoutSeconds * 1000) }),
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
		let autoAsyncTimer: NodeJS.Timeout | undefined;
		// A refused transition is a real, inspectable policy outcome, not a silent fallback.
		let transitionRefused: string | undefined;

		const cleanup = (): void => {
			streaming = false;
			if (autoAsyncTimer !== undefined) clearTimeout(autoAsyncTimer);
			signal?.removeEventListener("abort", onAbort);
		};

		const finishForeground = (jobSnapshot: BashJobSnapshot): void => {
			if (settled) return;
			settled = true;
			cleanup();
			const output = sink.finish();
			const timedOut = jobSnapshot.timedOut;
			const exitCode = jobSnapshot.exitCode ?? (timedOut ? 124 : 0);
			const result = textToolResult(
				transitionRefused === undefined
					? output.output
					: `${output.output}\n\nThis command stayed in the foreground: it could not become a background task (${transitionRefused}).`,
				{
					...output,
					...(timedOut ? { timedOut: true } : {}),
					exitCode,
					...(transitionRefused === undefined ? {} : { transitionRefused }),
				},
			);
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
			sink.finish();
			resolve(
				withBashStructuredContent(textToolResult("Bash aborted", { error: "aborted" }), {
					output: "Bash aborted",
					truncated: false,
					exitCode: 130,
					startedAt,
				}) as BashToolResult,
			);
		};

		signal?.addEventListener("abort", onAbort, { once: true });

		if (shouldAutoAsync) {
			autoAsyncTimer = setTimeout(() => {
				if (settled) return;
				const current = jobs.get(job.id);
				if (current === undefined || current.status !== "running") return;

				let task: TaskSnapshot | undefined;
				try {
					task = promoteBashJobToTask({
						tasks,
						jobs,
						jobId: job.id,
						command,
						...(anchor === undefined ? {} : { anchor }),
					});
				} catch (error) {
					// Admission refused the transition, so the command keeps waiting in the foreground
					// instead of losing its result or blocking new tasks. The model and the user both
					// need to know that the 60s policy did not apply this time.
					transitionRefused = errorMessage(error);
					context.ui.notify(
						`bash stayed in the foreground: background task refused (${transitionRefused})`,
						"warning",
					);
					return;
				}
				if (task === undefined) return;

				settled = true;
				cleanup();
				// A very short command can finish between the promotion and this message, so report
				// what the task actually reached instead of claiming it is still running.
				const currentTask = tasks.get(task.id) ?? task;
				const finished = currentTask.status !== "running";
				const snapshotOutput = finished ? sink.finish() : sink.snapshot();
				const message = finished
					? `Command completed while transitioning to background task ${task.id} (status: ${currentTask.status}).\n\n` +
						`Output:\n${snapshotOutput.output}`
					: `Command has been running for ${autoAsyncSeconds}s without an explicit timeout.\n` +
						`To avoid blocking the session, it was transitioned to background task ${task.id}.\n\n` +
						`Output preview so far:\n${snapshotOutput.output}\n\n` +
						`The command is STILL RUNNING in the background. Its result will be added to the context when finished.\n` +
						`- To wait for it now: wait_tasks({ ids: ["${task.id}"] })\n` +
						`- To stop it: stop_tasks({ ids: ["${task.id}"] })`;

				const result = textToolResult(message, {
					taskId: task.id,
					type: task.type,
					status: currentTask.status,
					autoAsyncTransition: true,
					elapsedSeconds: autoAsyncSeconds,
					purpose: task.purpose,
					outputPreview: snapshotOutput.output,
					truncated: snapshotOutput.truncated,
				});
				resolve(
					withBashStructuredContent(result, {
						output: snapshotOutput.output,
						truncated: snapshotOutput.truncated,
						exitCode: 0,
						startedAt,
					}) as BashToolResult,
				);
			}, autoAsyncSeconds * 1000);
		}
		jobs.waitFor(job.id).then((finalSnapshot) => {
			if (finalSnapshot) finishForeground(finalSnapshot);
		});
	});
}

/**
 * The frame header states how the call was made. The command itself is the request body, so only an
 * explicit timeout and a non-blocking request are worth repeating above it.
 */
function bashHeaderFacts(args: Input): string | undefined {
	const facts: string[] = [];
	if (args.blocking === false) facts.push("non-blocking");
	if (typeof args.timeout === "number") facts.push(`(timeout ${args.timeout}s)`);
	return facts.length === 0 ? undefined : facts.join(" ");
}

function bashResultWarning(result: { readonly details: unknown }): boolean {
	if (typeof result.details !== "object" || result.details === null) return false;
	const details = result.details as Record<string, unknown>;
	return (
		details.timedOut === true ||
		details.autoAsyncTransition === true ||
		(typeof details.exitCode === "number" && details.exitCode !== 0)
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
	const startedAt = performance.now();
	if (signal?.aborted)
		return withBashStructuredContent(textToolResult("Bash aborted", { error: "aborted", target }), {
			output: "Bash aborted",
			truncated: false,
			exitCode: 130,
			startedAt,
		}) as BashToolResult;
	const sink = new BashOutputSink(tailBytes);
	try {
		const { code, timedOut } = await runtime.exec(target, command, {
			...(signal === undefined ? {} : { signal }),
			...(timeoutSeconds === undefined || timeoutSeconds <= 0
				? {}
				: { timeoutMs: timeoutSeconds * 1000 }),
			onData: outputStreamer(sink, onUpdate),
		});
		const output = sink.finish();
		const exitCode = code ?? (timedOut ? 124 : 0);
		const result = textToolResult(output.output, {
			...output,
			...(timedOut ? { timedOut: true } : {}),
			exitCode,
			target,
			outcome: timedOut ? "timeout" : "ok",
		});
		return withBashStructuredContent(result, {
			output: output.output,
			truncated: output.truncated,
			exitCode,
			startedAt,
		}) as BashToolResult;
	} catch (error) {
		const output = sink.finish();
		if (isTargetError(error)) {
			const aborted = error.outcome === "cancelled";
			const result = textToolResult(aborted ? "Bash aborted" : error.message, {
				...output,
				error: aborted ? "aborted" : error.outcome,
				outcome: error.outcome,
				target,
			});
			return withBashStructuredContent(result, {
				output: output.output || error.message,
				truncated: output.truncated,
				exitCode: aborted ? 130 : 1,
				startedAt,
			}) as BashToolResult;
		}
		throw error;
	}
}

/** Pi original definition remains default execution; background control is extension-owned. */
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
		promptSnippet: BASH_DESCRIPTION,
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
			const output = agentResultText(result);
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
			const validatedParams = normalizeBashInput(params);
			if (!Value.Check(BashInput, validatedParams)) throw new Error("Invalid bash parameters");
			const settings = state?.getSettings();
			const background = validatedParams.blocking === false;
			const startedAt = performance.now();
			if (isRemoteBashTarget(validatedParams.target)) {
				if (background)
					return withBashStructuredContent(
						textToolResult("Background Bash is local-only; omit blocking for SSH targets.", {
							error: "background_unsupported",
							target: validatedParams.target,
						}),
						{
							output: "Background Bash is local-only; omit blocking for SSH targets.",
							truncated: false,
							exitCode: 1,
							startedAt,
						},
					);
				const runtime = state?.getTargetRuntime();
				if (runtime === undefined) throw new Error("Target runtime is unavailable.");
				return runRemoteBash(
					validatedParams.target,
					validatedParams.command,
					runtime,
					signal,
					onUpdate,
					validatedParams.timeout,
					(settings?.bashOutputTailKiB ?? 10) * 1024,
				);
			}
			const tasks = state?.getTasks();
			const jobs = state?.getBashJobs();
			const anchor = taskAnchor(context);
			if (background) {
				if (settings === undefined || tasks === undefined || jobs === undefined)
					return withBashStructuredContent(
						textToolResult("Background Bash unavailable outside active session", {
							error: "session_unavailable",
						}),
						{
							output: "Background Bash unavailable outside active session",
							truncated: false,
							exitCode: 1,
							startedAt,
						},
					);
				try {
					const task = startBashTask({
						tasks,
						jobs,
						command: validatedParams.command,
						cwd: context.cwd,
						shellPath: settings.shellPath,
						...(anchor === undefined ? {} : { anchor }),
						...(validatedParams.timeout === undefined
							? {}
							: { timeoutMs: Math.max(0, validatedParams.timeout * 1000) }),
					});
					const msg = `Started background task ${task.id}. Its result is added to the context when it finishes; use wait_tasks only if the next step needs it now.`;
					return withBashStructuredContent(
						textToolResult(msg, {
							taskId: task.id,
							type: task.type,
							status: task.status,
							purpose: task.purpose,
						}),
						{
							output: msg,
							truncated: false,
							exitCode: 0,
							startedAt,
						},
					);
				} catch (error) {
					const msg = `Unable to start background task: ${errorMessage(error)}`;
					return withBashStructuredContent(
						textToolResult(msg, {
							error: "start_failed",
						}),
						{
							output: msg,
							truncated: false,
							exitCode: 1,
							startedAt,
						},
					);
				}
			}
			return runForeground(
				validatedParams.command,
				context,
				signal,
				onUpdate,
				settings?.shellPath ?? defaultShellPath(),
				validatedParams.timeout,
				(settings?.bashOutputTailKiB ?? 10) * 1024,
				anchor,
				jobs,
				tasks,
				// An explicit blocking request waits, so only an omitted `blocking` may promote.
				validatedParams.blocking === true
					? 0
					: (settings?.autoAsyncSeconds ?? DEFAULT_FFF_SETTINGS.autoAsyncSeconds),
			);
		},
	} as unknown as ToolDefinition<typeof BashInput, unknown, unknown>;
	registerManagedTool(
		pi,
		{
			id: "bash",
			owner: OWNER,
		},
		tui.frame(tool, {
			maxBodyLines: Number.POSITIVE_INFINITY,
			longOutput: true,
			// The command is a request body, so the header carries only invocation facts.
			headerLine: "truncate",
			summary: () => "",
			suffix: bashHeaderFacts,
			request: (args, theme) => {
				const command = typeof args.command === "string" ? args.command : "";
				return command === ""
					? undefined
					: new WrappedTextBody(stripTerminalSequences(command), theme);
			},
			footer: (result, completion, options) =>
				options.isPartial ? undefined : bashFooter(result, completion),
			warning: bashResultWarning,
		}),
	);
	return tool;
}

export { BashInput };
