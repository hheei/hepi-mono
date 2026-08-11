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
import { type Component, Text } from "@earendil-works/pi-tui";
import type { OutputRegistry } from "@hheei/pi-ext-core";
import {
	createOutputRegistry,
	openTuiSurface,
	registerManagedLoadoutTool,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { BashOutputSink } from "./bash-output.js";
import { BashPtySurface, type BashPtySurfaceResult } from "./bash-pty-surface.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { PtySession } from "./native-bridge.js";
import { withToolFrame } from "./pretty/frame.js";
import { type ToolCompletion, ToolTraceController } from "./pretty/trace.js";

const OWNER = "@hheei/pi-ext-tools";
const fallbackOutputs = createOutputRegistry();
const BASH_DESCRIPTION = "Run one shell command or short pipeline.";
const BASH_PROMPT_SNIPPET = "Run one shell command or short pipeline.";
const BASH_PROMPT_GUIDELINES = [
	"Use `async` only for finite commands that may outlive this tool call.",
	"Use `pty` only for interactive terminal programs such as `sudo` or `ssh`.",
	"NEVER combine `pty` with `async`.",
] as const;
const Timeout = Type.Optional(
	Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
);
const DefaultInput = Type.Object(
	{ command: Type.String(), timeout: Timeout },
	{ additionalProperties: false },
);
const AsyncInput = Type.Object(
	{
		command: Type.String(),
		timeout: Timeout,
		async: Type.Literal(true),
		pty: Type.Optional(Type.Literal(false)),
	},
	{ additionalProperties: false },
);
const PtyInput = Type.Object(
	{
		command: Type.String(),
		timeout: Timeout,
		pty: Type.Literal(true),
		async: Type.Optional(Type.Literal(false)),
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
	const duration =
		completion?.durationMs === undefined
			? "completed"
			: completion.durationMs < 1_000
				? `${completion.durationMs}ms`
				: `${(completion.durationMs / 1_000).toFixed(1)}s`;
	return `exitcode ${exitCode} · ${lineCount(output)} lines · ${duration}`;
}

class BashOutputFrame implements Component {
	constructor(
		private readonly body: Component,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		return [
			...this.body.render(width),
			this.theme.fg("borderMuted", "─".repeat(Math.max(1, width))),
		];
	}

	invalidate(): void {
		this.body.invalidate();
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

/** Pi original definition remains default execution; async is extension-owned and session-scoped. */
export function registerBashTool(
	pi: ExtensionAPI,
	state?: FffRuntimeState,
	trace = new ToolTraceController(),
): void {
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
			const body = upstreamRenderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
			return new BashOutputFrame(body, theme);
		},
		async execute(
			_id: string,
			params: Input,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			context: ExtensionContext,
		) {
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
		withToolFrame(tool, trace, bashFooter, bashResultWarning),
	);
}

export { BashInput };
