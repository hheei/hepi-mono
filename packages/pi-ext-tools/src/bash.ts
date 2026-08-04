import { readFile } from "node:fs/promises";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	type BashToolDetails,
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { openTuiSurface, registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { BashPtySurface, type BashPtySurfaceResult } from "./bash-pty-surface.js";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { PtySession } from "./native-bridge.js";

const OWNER = "@hheei/pi-ext-tools";
const BASH_DESCRIPTION =
	"Execute a shell command in the current working directory. Default calls use Pi host Bash; async starts a session-owned job and pty opens an interactive terminal.";
const BASH_PROMPT_SNIPPET =
	"Execute shell commands and manage explicit async or interactive PTY work";
const BASH_PROMPT_GUIDELINES = [
	"Use bash only for one binary or a short pipeline that computes a fact; use dedicated file tools instead of shell grep, find, ls, head, or tail.",
	"Use async: true only for finite work that may outlive this tool call; use bash_job with its returned id to inspect logs, status, or stop it.",
	"Use pty: true only for interactive terminal programs such as sudo or ssh. It requires TUI mode, never falls back to normal Bash, and is mutually exclusive with async.",
	"Use timeout for a command deadline; it does not make async work foreground or extend a PTY session.",
] as const;
const DefaultInput = Type.Object(
	{ command: Type.String(), timeout: Type.Optional(Type.Number()) },
	{ additionalProperties: false },
);
const AsyncInput = Type.Object(
	{
		command: Type.String(),
		timeout: Type.Optional(Type.Number()),
		async: Type.Literal(true),
		pty: Type.Optional(Type.Literal(false)),
	},
	{ additionalProperties: false },
);
const PtyInput = Type.Object(
	{
		command: Type.String(),
		timeout: Type.Optional(Type.Number()),
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

function result(text: string, details: Record<string, unknown> = {}): BashToolResult {
	return { content: [{ type: "text" as const, text }], details };
}

async function runPty(
	pi: ExtensionAPI,
	command: string,
	context: ExtensionContext,
	signal: AbortSignal | undefined,
	shellPath: string | undefined,
	timeoutSeconds: number | undefined,
): Promise<BashToolResult> {
	if (context.mode !== "tui" || process.env.PI_NO_PTY === "1")
		return result("PTY Bash requires an interactive TUI with PTY enabled", {
			error: "pty_unavailable",
		});
	const controller = new AbortController();
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
		return result(
			outcome.output,
			outcome.status === "completed"
				? {
						code: outcome.exit.code,
						...(outcome.exit.signal === undefined ? {} : { signal: outcome.exit.signal }),
					}
				: { error: "aborted" },
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

/** Pi original definition remains default execution; async is extension-owned and session-scoped. */
export function registerBashTool(pi: ExtensionAPI, state?: FffRuntimeState): void {
	const template = createBashToolDefinition(process.cwd());
	const tool = {
		...template,
		description: BASH_DESCRIPTION,
		promptSnippet: BASH_PROMPT_SNIPPET,
		promptGuidelines: [...(template.promptGuidelines ?? []), ...BASH_PROMPT_GUIDELINES],
		parameters: BashInput,
		async execute(
			id: string,
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
					return result(`Started Bash job ${job.id}`, { ...job, output: undefined });
				} catch (error) {
					return result(
						`Unable to start Bash job: ${error instanceof Error ? error.message : String(error)}`,
						{ error: "start_failed" },
					);
				}
			}
			const originalParams = {
				command: params.command,
				...(params.timeout === undefined ? {} : { timeout: params.timeout }),
			};
			const safeUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined =
				onUpdate === undefined
					? undefined
					: (partial) => {
							const details = partial.details;
							if (details?.fullOutputPath === undefined) {
								onUpdate(partial);
								return;
							}
							const { fullOutputPath: _path, ...safeDetails } = details;
							onUpdate({ ...partial, details: safeDetails });
						};
			const hostResult = await createBashToolDefinition(context.cwd).execute(
				id,
				originalParams,
				signal,
				safeUpdate,
				context,
			);
			const details = hostResult.details as BashToolDetails | undefined;
			const fullOutputPath = details?.fullOutputPath;
			if (details?.truncation?.truncated && fullOutputPath !== undefined) {
				const artifacts = state?.getArtifacts();
				if (artifacts !== undefined) {
					const uri = artifacts.create(await readFile(fullOutputPath, "utf8"));
					const text = hostResult.content
						.map((part) => (part.type === "text" ? part.text.replaceAll(fullOutputPath, uri) : ""))
						.join("\n");
					const { fullOutputPath: _path, ...safeDetails } = details;
					return {
						content: [{ type: "text", text }],
						details: { ...safeDetails, outputArtifact: uri },
					};
				}
			}
			return hostResult;
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
		tool,
	);
}

export { BashInput };
