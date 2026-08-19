import { spawn } from "node:child_process";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	type AgentToolResult,
	createBashToolDefinition,
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
import type { OutputRegistry } from "@hheei/pi-ext-core";
import {
	createOutputRegistry,
	createToolTui,
	DEFAULT_MAX_BODY_LINES,
	openTuiSurface,
	registerManagedLoadoutTool,
	type ToolCompletion,
	type ToolTui,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { BashOutputSink } from "./bash-output.js";
import { BashPtySurface, type BashPtySurfaceResult } from "./bash-pty-surface.js";
import { counted } from "./counted.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { PtySession } from "./native-bridge.js";
import { rejectUnsupportedTarget } from "./targets.js";

const OWNER = "@hheei/pi-ext-tools";
const fallbackOutputs = createOutputRegistry();
const BASH_DESCRIPTION = "Run one shell command or short pipeline.";
const BASH_PROMPT_SNIPPET = "Run one shell command or short pipeline.";
const BASH_PROMPT_GUIDELINES = [
	"Use `async` only for finite commands that may outlive this tool call.",
	"Use `pty` only for interactive terminal programs such as `sudo` or `ssh`.",
	"NEVER combine `pty` with `async`.",
] as const;
const BASH_TIMEOUT_DESCRIPTION = "Timeout in seconds (optional, no default timeout)";
const RTK_REWRITE_TIMEOUT_MS = 1_000;
const Timeout = Type.Optional(Type.Number({ description: BASH_TIMEOUT_DESCRIPTION }));
const Target = Type.Optional(
	Type.String({ description: "Unsupported; bash only runs on the local workspace." }),
);
const DefaultInput = Type.Object(
	{ command: Type.String(), timeout: Timeout, target: Target },
	{ additionalProperties: false },
);
const AsyncInput = Type.Object(
	{
		command: Type.String(),
		timeout: Timeout,
		async: Type.Literal(true),
		pty: Type.Optional(Type.Literal(false)),
		target: Target,
	},
	{ additionalProperties: false },
);
const PtyInput = Type.Object(
	{
		command: Type.String(),
		timeout: Timeout,
		pty: Type.Literal(true),
		async: Type.Optional(Type.Literal(false)),
		target: Target,
	},
	{ additionalProperties: false },
);
const BashInput = Type.Union([DefaultInput, AsyncInput, PtyInput]);
type Input = Static<typeof BashInput>;
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
	outputs: OutputRegistry,
): Promise<BashToolResult> {
	if (signal?.aborted) return result("Bash aborted", { error: "aborted" });
	const sink = new BashOutputSink({ outputs, tailBytes });
	const child = spawn(
		shellPath,
		process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command],
		{ cwd: context.cwd, stdio: ["ignore", "pipe", "pipe"] },
	);
	let timedOut = false;
	const terminate = (): void => {
		child.kill();
	};
	signal?.addEventListener("abort", terminate, { once: true });
	const timeout =
		timeoutSeconds === undefined || timeoutSeconds <= 0
			? undefined
			: setTimeout(() => {
					timedOut = true;
					terminate();
				}, timeoutSeconds * 1000);
	const update = (data: Buffer): void => {
		sink.push(data);
		const output = sink.snapshot();
		onUpdate?.({ content: [{ type: "text", text: output.output }], details: output });
	};
	child.stdout?.on("data", update);
	child.stderr?.on("data", update);
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	clearTimeout(timeout);
	signal?.removeEventListener("abort", terminate);
	const output = sink.finish();
	return result(
		`${output.output}${output.truncated && output.outputUri ? `\n\n[Output truncated. Read ${output.outputUri} for full output.]` : ""}`,
		{
			...output,
			...(timedOut ? { timedOut: true } : {}),
			exitCode,
		},
	);
}

async function runPty(
	pi: ExtensionAPI,
	command: string,
	context: ExtensionContext,
	signal: AbortSignal | undefined,
	shellPath: string | undefined,
	timeoutSeconds: number | undefined,
	tailBytes: number,
	outputs: OutputRegistry,
): Promise<BashToolResult> {
	if (context.mode !== "tui" || process.env.PI_NO_PTY === "1")
		return result("PTY Bash requires an interactive TUI with PTY enabled", {
			error: "pty_unavailable",
		});
	const controller = new AbortController();
	const sink = new BashOutputSink({ outputs, tailBytes });
	const abort = (): void => controller.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	let timeout: NodeJS.Timeout | undefined;
	try {
		const surface = await openTuiSurface<BashPtySurfaceResult>(pi, context, {
			hostId: "@hheei/pi-ext-tools/bash-pty",
			signal: controller.signal,
			maxPending: 0,
			overlay: true,
			beforeRelease: () => clearTimeout(timeout),
			create: ({ theme, close, requestRender }) => {
				const shell = shellPath ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
				const args = process.platform === "win32" ? ["/c", command] : ["-lc", command];
				const session = new PtySession({
					command: shell,
					args,
					cwd: context.cwd,
					env: { TERM: "xterm-256color" },
					rows: 16,
					cols: 80,
				});
				const decoder = new TextDecoder();
				const component = new BashPtySurface(command, session, theme, close);
				if (timeoutSeconds !== undefined && timeoutSeconds > 0)
					timeout = setTimeout(() => session.close(), timeoutSeconds * 1000);
				void (async (): Promise<void> => {
					try {
						for (;;) {
							const chunk = await session.read();
							sink.push(chunk.output);
							component.append(chunk.output, decoder);
							requestRender();
							if (chunk.eof) break;
						}
						const exit = await session.wait();
						component.complete(exit, decoder);
						requestRender();
					} catch {
						component.complete({ code: 1, signal: "terminated" }, decoder);
						requestRender();
					}
				})();
				return component;
			},
		});
		if (surface.status === "aborted") return result("PTY Bash aborted", { error: "aborted" });
		const outcome: BashPtySurfaceResult = surface.value;
		const output = sink.finish();
		return result(
			`${output.output}${output.truncated && output.outputUri ? `\n\n[Output truncated. Read ${output.outputUri} for full output.]` : ""}`,
			outcome.status === "completed"
				? {
						...output,
						exitCode: outcome.exit.code,
						...(outcome.exit.signal === undefined ? {} : { signal: outcome.exit.signal }),
					}
				: { ...output, error: "aborted" },
		);
	} catch (error) {
		return result(
			`Unable to start PTY Bash: ${error instanceof Error ? error.message : String(error)}`,
			{
				error: "pty_start_failed",
			},
		);
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}

function bashResultWarning(result: { readonly details: unknown }): boolean {
	if (typeof result.details !== "object" || result.details === null) return false;
	const details = result.details as Record<string, unknown>;
	return (
		details.timedOut === true || (typeof details.exitCode === "number" && details.exitCode !== 0)
	);
}

function fieldIsTrue(value: object, key: string): boolean {
	return Object.getOwnPropertyDescriptor(value, key)?.value === true;
}

function skipRtkRewrite(command: string): boolean {
	if (command.trim() === "") return true;
	const body = command
		.trimStart()
		.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:(?:"[^"]*"|'(?:'\\''|[^'])*'|[^\s]+)\s+))+/, "")
		.trimStart();
	return body === "rtk" || body.startsWith("rtk ");
}

async function rewriteWithRtk(
	pi: ExtensionAPI,
	executable: string,
	command: string,
	signal: AbortSignal | undefined,
): Promise<{
	readonly command: string;
	readonly warning?: string;
}> {
	if (skipRtkRewrite(command) || signal?.aborted) return { command };
	try {
		const rewritten = await pi.exec(executable, ["rewrite", command], {
			timeout: RTK_REWRITE_TIMEOUT_MS,
			...(signal === undefined ? {} : { signal }),
		});
		if (signal?.aborted) return { command };
		if (rewritten.killed) return { command, warning: "RTK rewrite failed (timeout)" };
		if (rewritten.code === 1) return { command };
		const output = rewritten.stdout.trim();
		if ((rewritten.code === 0 || rewritten.code === 3) && output !== "" && output !== command)
			return { command: output };
		if (rewritten.code === 0 || rewritten.code === 3) {
			if (output === command) return { command };
			return { command, warning: "RTK rewrite failed (rtk returned empty output)" };
		}
		return {
			command,
			warning: `RTK rewrite failed (${rewritten.stderr.trim() || `exit ${rewritten.code}`})`,
		};
	} catch (error) {
		if (signal?.aborted) return { command };
		return {
			command,
			warning: `RTK rewrite unavailable (${error instanceof Error ? error.message : String(error)})`,
		};
	}
}

function registerRtkForegroundRewrite(pi: ExtensionAPI, state: FffRuntimeState): void {
	pi.on("tool_call", async (event, context) => {
		const rtkSettings = state.getRtkSettings();
		if (rtkSettings.enabled !== true || event.toolName !== "bash") return undefined;
		const input = event.input;
		if (fieldIsTrue(input, "async") || fieldIsTrue(input, "pty")) return undefined;
		const command = input.command;
		if (typeof command !== "string" || command.trim() === "") return undefined;
		const rewritten = await rewriteWithRtk(pi, rtkSettings.path || "rtk", command, context.signal);
		if (rewritten.command !== command) input.command = rewritten.command;
		if (rewritten.warning !== undefined && context.hasUI && state.consumeRtkRewriteWarning())
			context.ui.notify(`${rewritten.warning}; running original Bash command`, "warning");
		return undefined;
	});
}

/** Pi original definition remains default execution; async is extension-owned and session-scoped. */
export function registerBashTool(
	pi: ExtensionAPI,
	state?: FffRuntimeState,
	tui: ToolTui = createToolTui(),
): void {
	if (state !== undefined) registerRtkForegroundRewrite(pi, state);
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
			rejectUnsupportedTarget("bash", params);
			if ("pty" in params && params.pty === true)
				return runPty(
					pi,
					params.command,
					context,
					signal,
					state?.getSettings().shellPath,
					params.timeout,
					(state?.getSettings().bashOutputTailKiB ?? 10) * 1024,
					state?.getOutputs() ?? fallbackOutputs,
				);
			if ("async" in params && params.async === true) {
				const jobs = state?.getBashJobs();
				if (jobs === undefined)
					return result("Async Bash unavailable outside active session", {
						error: "session_unavailable",
					});
				try {
					const job = jobs.start(
						params.command,
						context.cwd,
						state?.getSettings().shellPath,
						params.timeout === undefined ? undefined : Math.max(0, params.timeout * 1000),
					);
					return result(`Started Bash job ${job.id}`, {
						id: job.id,
						command: job.command,
						cwd: job.cwd,
						status: job.status,
						exitCode: job.exitCode,
						startedAt: job.startedAt,
						timedOut: job.timedOut,
						...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
						...(job.outputOutput === undefined ? {} : { outputOutput: job.outputOutput }),
					});
				} catch (error) {
					return result(
						`Unable to start Bash job: ${error instanceof Error ? error.message : String(error)}`,
						{ error: "start_failed" },
					);
				}
			}
			return runForeground(
				params.command,
				context,
				signal,
				onUpdate,
				state?.getSettings().shellPath ?? process.env.SHELL ?? "/bin/sh",
				params.timeout,
				(state?.getSettings().bashOutputTailKiB ?? 10) * 1024,
				state?.getOutputs() ?? fallbackOutputs,
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
}

export { BashInput };
