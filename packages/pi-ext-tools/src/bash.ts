import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	type AgentToolResult,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type Theme,
	type ToolDefinition,
	type ToolLoadout,
	type ToolLoadoutChanges,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { agentResultText, errorMessage, isRecord, textToolResult } from "@hheei/pi-ext-core";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { backgroundBashRenderers } from "./background-presentation.js";
import { type BashJobRegistry, type BashJobSnapshot, defaultShellPath } from "./bash-jobs.js";
import { BashOutputSink } from "./bash-output.js";
import { isSearchOnlyCommand, SEARCH_BASH_TIMEOUT_SECONDS } from "./bash-search.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";

import { isTargetError, LOCAL_TARGET, type TargetRuntime } from "./targets.js";

/** Unexpanded output rows. Matches the request cap so a command and its output weigh the same. */
const BASH_MAX_BODY_LINES = 10;

const BASH_DESCRIPTION = "Run one shell command or short pipeline in the foreground.";
const BASH_PROMPT_GUIDELINES = [
	"Remote `target` is an authorized SSH host and always runs in the foreground.",
] as const;
const BASH_TIMEOUT_DESCRIPTION =
	"Timeout in seconds (optional, default 180s, or 25s for pure search commands like rg/fd/grep/find)";
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
		target: Target,
	},
	{ additionalProperties: false },
);
type Input = Static<typeof BashInput>;

const SPAWN_BASH_DESCRIPTION =
	"Start a shell command in the background as a task and return JSON { id, path }, where path is the absolute log file path. The terminal result is delivered automatically via <task-notice> when the command finishes. Related background task tools: bg_bash_get, bg_bash_stop.";
const SPAWN_BASH_PROMPT_GUIDELINES = [
	"Use bg_bash_spawn for commands that run for a long time (tests, builds, dev servers, watchers).",
	"bg_bash_spawn returns JSON { id, path }, where path is the absolute log file path. Terminal completion is delivered via <task-notice> and automatically wakes a follow-up turn.",
	"After calling bg_bash_spawn, yield the turn or continue other independent work. Do NOT poll or sleep merely to wait for completion.",
	"Read or grep the returned path for full output; bg_bash_get progress.path provides the same path.",
] as const;

export const BG_BASH_PROMPT_SECTION = "bg_bash_guidance";
export const BG_BASH_TOOL_SEARCH_BULLET =
	'Run long-running shell commands in the background (bg_bash_spawn, bg_bash_get, bg_bash_stop). Use tool_search ({ query: "bg_bash" }) to load.';
export const BG_BASH_CODEMODE_BULLET =
	"Run long-running shell commands in the background (bg_bash_spawn, bg_bash_get, bg_bash_stop). Call from codemode scripts via tools.bg_bash_spawn.";
export const BG_BASH_GUIDANCE = [
	"Use bg_bash_spawn for commands that run for a long time (tests, builds, dev servers, watchers).",
	"bg_bash_spawn returns JSON { id, path }, where path is the absolute log file path. Terminal completion is delivered via <task-notice> and automatically wakes a follow-up turn.",
	"After calling bg_bash_spawn, yield the turn or continue other independent work. Do NOT poll bg_bash_get or sleep merely to wait for completion.",
	"Read or grep the returned path for full output; bg_bash_get progress.path provides the same path.",
	"Use bg_bash_stop to explicitly terminate any running background bash task by its taskId (e.g. bash-1).",
].join("\n");
const SpawnBashInput = Type.Object(
	{
		command: Type.String({ minLength: 1, description: "Shell command to run in the background" }),
		timeout: Type.Optional(
			Type.Number({
				description:
					"Timeout in seconds; no timeout by default, except 25s for pure search commands.",
			}),
		),
	},
	{ additionalProperties: false },
);
type SpawnBashParams = Static<typeof SpawnBashInput>;

function normalizeBashInput(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const input = { ...(value as Record<string, unknown>) };
	if (input.timeout === null) delete input.timeout;
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
					timeout: effectiveTimeout,
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

		const cleanup = (): void => {
			streaming = false;
			signal?.removeEventListener("abort", onAbort);
		};

		const finishForeground = (jobSnapshot: BashJobSnapshot): void => {
			if (settled) return;
			settled = true;
			cleanup();
			const output = sink.finish();
			const timedOut = jobSnapshot.timedOut;
			const isFailed = jobSnapshot.status === "failed";
			const exitCode = jobSnapshot.exitCode ?? (timedOut ? 124 : isFailed ? 127 : 0);
			const isError = isFailed || exitCode !== 0;
			const result = textToolResult(output.output, {
				...output,
				...(timedOut ? { timedOut: true } : {}),
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
		jobs.waitFor(job.id).then((finalSnapshot) => {
			if (finalSnapshot) finishForeground(finalSnapshot);
		});
	});
}

/**
 * The frame header states how the call was made. The command itself is the request body, so only an
 * explicit timeout and a non-blocking request are worth repeating above it.
 */
function _bashHeaderFacts(args: Input): string | undefined {
	const facts: string[] = [];
	if (typeof args.timeout === "number") facts.push(`(timeout ${args.timeout}s)`);
	return facts.length === 0 ? undefined : facts.join(" ");
}

function _bashResultWarning(result: { readonly details: unknown }): boolean {
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
	const startedAt = performance.now();
	if (signal?.aborted)
		return withBashStructuredContent(textToolResult("Bash aborted", { error: "aborted", target }), {
			output: "Bash aborted",
			truncated: false,
			exitCode: 130,
			startedAt,
		}) as BashToolResult;
	const effectiveTimeout = timeoutSeconds ?? resolveDefaultBashTimeout(command);
	const sink = new BashOutputSink(tailBytes);
	try {
		const { code, timedOut } = await runtime.exec(target, command, {
			...(signal === undefined ? {} : { signal }),
			...(effectiveTimeout <= 0 ? {} : { timeoutMs: effectiveTimeout * 1000 }),
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
export function registerBashTool(pi: ExtensionAPI, state?: FffRuntimeState): ToolDefinition {
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
			if (isRemoteBashTarget(validatedParams.target)) {
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

	const spawnBashTool: ToolDefinition<typeof SpawnBashInput, unknown> = {
		name: "bg_bash_spawn",
		...backgroundBashRenderers(pi, "bg_bash_spawn"),
		namespace: { name: "bg_bash", description: "Background Bash commands" },
		label: "bg_bash_spawn",
		description: SPAWN_BASH_DESCRIPTION,
		promptSnippet: "Start a background shell command; terminal notification wakes a follow-up turn",
		promptGuidelines: [...SPAWN_BASH_PROMPT_GUIDELINES],
		parameters: SpawnBashInput,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			openWorldHint: true,
			destructiveHint: true,
		},
		async execute(
			_id: string,
			params: SpawnBashParams,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			context: ExtensionContext,
		) {
			const validatedParams = params;
			if (!Value.Check(SpawnBashInput, validatedParams))
				throw new Error("Invalid bg_bash_spawn parameters");
			const settings = state?.getSettings();
			const tasks = state?.getTasks();
			const jobs = state?.getBashJobs();
			if (settings === undefined || tasks === undefined || jobs === undefined) {
				return {
					...textToolResult("Background Bash unavailable outside active session", undefined),
					isError: true,
				};
			}
			const anchor = taskAnchor(context);
			const sessionId = context.sessionManager?.getSessionId?.() ?? "session";
			const sessionFile = context.sessionManager?.getSessionFile?.();
			const baseDir = sessionFile ? dirname(sessionFile) : join(getAgentDir(), "sessions");
			const logDir = join(baseDir, "tasks", sessionId);
			try {
				mkdirSync(logDir, { recursive: true });
				const { task } = jobs.startAsTask(tasks, {
					command: validatedParams.command,
					cwd: context.cwd,
					shellPath: settings.shellPath,
					resolveLogPath: (taskId) => join(logDir, `${taskId}.log`),
					...(anchor === undefined ? {} : { anchor }),
					...(validatedParams.timeout === undefined
						? isSearchOnlyCommand(validatedParams.command)
							? { timeoutMs: SEARCH_BASH_TIMEOUT_SECONDS * 1000 }
							: {}
						: { timeoutMs: Math.max(0, validatedParams.timeout * 1000) }),
				});
				const id = task.id;
				const path = join(logDir, `${id}.log`);
				return textToolResult(JSON.stringify({ id, path }), { id, path });
			} catch (error) {
				const msg = `Unable to start background job: ${errorMessage(error)}`;
				return { ...textToolResult(msg, undefined), isError: true };
			}
		},
	};
	pi.registerTool(spawnBashTool);

	return tool;
}

export {
	BashInput,
	isSearchOnlyCommand,
	SEARCH_BASH_TIMEOUT_SECONDS,
	SpawnBashInput,
	Target,
	Timeout,
};
