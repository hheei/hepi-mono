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
	registerManagedTool,
	type ToolCompletion,
	type ToolTui,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type BashJobRegistry, type BashJobSnapshot, defaultShellPath } from "./bash-jobs.js";
import { BashOutputSink } from "./bash-output.js";
import { counted } from "./counted.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { DEFAULT_FFF_SETTINGS } from "./fff/settings.js";
import { isTargetError, LOCAL_TARGET, type TargetRuntime } from "./targets.js";
import { promoteBashJobToTask, startBashTask } from "./tasks/bash-task.js";
import type { AsyncTaskRegistry, AsyncTaskSnapshot } from "./tasks/registry.js";

const OWNER = "@hheei/pi-ext-tools";
const BASH_DESCRIPTION = "Run one shell command or short pipeline.";
const BASH_PROMPT_GUIDELINES = [
	"Use `async` only for finite commands that may outlive this tool call; its result is added to the context when it finishes.",
	"Do not poll background tasks. Use `wait_tasks` only when the next step needs their results.",
	"Local commands without timeout transition to background tasks (e.g. bash-1) after 60s. Use wait_tasks to wait or stop_tasks to terminate.",
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

function bashFooter(
	result: AgentToolResult<unknown>,
	completion: ToolCompletion | undefined,
): string {
	const details = detailsRecord(result.details);
	if (details.autoAsyncTransition === true && typeof details.taskId === "string") {
		const elapsed =
			typeof details.elapsedSeconds === "number" ? `${details.elapsedSeconds}s` : "60s";
		return `transitioned to ${details.taskId} · running in background · ${elapsed}`;
	}
	if (typeof details.taskId === "string") {
		return `task ${details.taskId} · background`;
	}
	const output = typeof details.output === "string" ? details.output : outputText(result);
	const exitCode = typeof details.exitCode === "number" ? details.exitCode : "?";
	const lines = outputTotalLines(result, output);
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
	const total = detailsRecord(result.details).totalLines;
	if (typeof total === "number" && Number.isFinite(total)) return total;
	return output === "" ? 0 : output.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

function outputText(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function outputStreamer(
	sink: BashOutputSink,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): (data: Buffer) => void {
	return (data) => {
		sink.push(data);
		const output = sink.snapshot();
		onUpdate?.({ content: [{ type: "text", text: output.output }], details: output });
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
		const budget = this.expanded ? lines.length : DEFAULT_MAX_BODY_LINES;
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
	jobs?: BashJobRegistry | undefined,
	tasks?: AsyncTaskRegistry | undefined,
	autoAsyncSeconds = 60,
): Promise<BashToolResult> {
	if (signal?.aborted) return result("Bash aborted", { error: "aborted" });
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
		return result(
			`Unable to start bash job: ${error instanceof Error ? error.message : String(error)}`,
			{ ...output, error: "start_failed" },
		);
	}

	return new Promise<BashToolResult>((resolve) => {
		let settled = false;
		let autoAsyncTimer: NodeJS.Timeout | undefined;

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
			resolve(
				result(output.output, {
					...output,
					...(timedOut ? { timedOut: true } : {}),
					exitCode: jobSnapshot.exitCode,
				}),
			);
		};

		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			jobs.stop(job.id);
			sink.finish();
			resolve(result("Bash aborted", { error: "aborted" }));
		};

		signal?.addEventListener("abort", onAbort, { once: true });

		if (shouldAutoAsync) {
			autoAsyncTimer = setTimeout(() => {
				if (settled) return;
				const current = jobs.get(job.id);
				if (current === undefined || current.status !== "running") return;

				let task: AsyncTaskSnapshot | undefined;
				try {
					task = promoteBashJobToTask({
						tasks,
						jobs,
						jobId: job.id,
						command,
					});
				} catch (error) {
					if (settled) return;
					settled = true;
					cleanup();
					jobs.stop(job.id);
					const snapshotOutput = sink.finish();
					resolve(
						result(
							`Unable to transition bash command to background task: ${error instanceof Error ? error.message : String(error)}`,
							{ ...snapshotOutput, error: "task_transition_failed" },
						),
					);
					return;
				}
				if (task === undefined) return;

				settled = true;
				cleanup();
				const currentTask = tasks.get(task.id) ?? task;
				if (currentTask.status !== "running") {
					const snapshotOutput = sink.finish();
					const message =
						`Command completed while transitioning to background task ${task.id} (status: ${currentTask.status}).\n\n` +
						`Output:\n${snapshotOutput.output}`;
					resolve(
						result(message, {
							taskId: task.id,
							type: task.type,
							status: currentTask.status,
							autoAsyncTransition: true,
							elapsedSeconds: autoAsyncSeconds,
							purpose: task.purpose,
							outputPreview: snapshotOutput.output,
							truncated: snapshotOutput.truncated,
						}),
					);
					return;
				}

				const snapshotOutput = sink.snapshot();
				const message =
					`Command has been running for ${autoAsyncSeconds}s without an explicit timeout.\n` +
					`To avoid blocking the session, it was transitioned to background task ${task.id}.\n\n` +
					`Output preview so far:\n${snapshotOutput.output}\n\n` +
					`The command is STILL RUNNING in the background. Its result will be added to the context when finished.\n` +
					`- To wait for it now: wait_tasks({ ids: ["${task.id}"] })\n` +
					`- To stop it: stop_tasks({ ids: ["${task.id}"] })`;

				resolve(
					result(message, {
						taskId: task.id,
						type: task.type,
						status: task.status,
						autoAsyncTransition: true,
						elapsedSeconds: autoAsyncSeconds,
						purpose: task.purpose,
						outputPreview: snapshotOutput.output,
						truncated: snapshotOutput.truncated,
					}),
				);
			}, autoAsyncSeconds * 1000);
		}

		jobs.waitFor(job.id).then((finalSnapshot) => {
			if (finalSnapshot) finishForeground(finalSnapshot);
		});
	});
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
	if (signal?.aborted) return result("Bash aborted", { error: "aborted", target });
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
			const validatedParams = normalizeBashInput(params);
			if (!Value.Check(BashInput, validatedParams)) throw new Error("Invalid bash parameters");
			const settings = state?.getSettings();
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
					(settings?.bashOutputTailKiB ?? 10) * 1024,
				);
			}
			const tasks = state?.getTasks();
			const jobs = state?.getBashJobs();
			if ("async" in validatedParams && validatedParams.async === true) {
				if (settings === undefined || tasks === undefined || jobs === undefined)
					return result("Async Bash unavailable outside active session", {
						error: "session_unavailable",
					});
				try {
					const task = startBashTask({
						tasks,
						jobs,
						command: validatedParams.command,
						cwd: context.cwd,
						shellPath: settings.shellPath,
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
						`Unable to start background task: ${error instanceof Error ? error.message : String(error)}`,
						{ error: "start_failed" },
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
				jobs,
				tasks,
				settings?.autoAsyncSeconds ?? DEFAULT_FFF_SETTINGS.autoAsyncSeconds,
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
			// The body renders output only, so a wrapped command would be unrecoverable.
			headerLine: "truncate",
			footer: (result, completion, options) =>
				options.isPartial ? undefined : bashFooter(result, completion),
			warning: bashResultWarning,
		}),
	);
	return tool;
}

export { BashInput };
