import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	errorMessage,
	isSearchOnlyCommand,
	SEARCH_BASH_TIMEOUT_SECONDS,
	textToolResult,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { isTerminalBashStatus } from "./bash-jobs.js";
import { bashExecutionDirectory } from "./bash-ledger.js";
import { bgBashPresentationRenderers } from "./bg-bash-presentation.js";
import type { BackgroundBashRuntimeState } from "./session-state.js";

export const BG_BASH_OPTIONAL_TOOL_KEY = "background bash";
export const BG_BASH_OPTIONAL_TOOL_BULLET =
	'background bash (query: "bg_bash"): Run long-running shell commands in background (bg_bash_spawn, bg_bash_get, bg_bash_stop).';

const SPAWN_BASH_DESCRIPTION =
	"Start a shell command in the background and return JSON { id, path }, where path is the absolute log file path. The terminal result is delivered automatically via bg-bash-report when the command finishes. Related background Bash tools: bg_bash_get, bg_bash_stop.";
const SPAWN_BASH_PROMPT_GUIDELINES = [
	"Use bg_bash_spawn for commands that run for a long time (tests, builds, dev servers, watchers).",
	"bg_bash_spawn returns JSON { id, path }, where path is the absolute log file path. Terminal completion is delivered automatically via bg-bash-report and wakes a follow-up turn.",
	"After calling bg_bash_spawn, yield the turn or continue other independent work. Do NOT poll or sleep merely to wait for completion.",
	"Read or grep the returned path for full output; bg_bash_get progress.path provides the same path.",
	"After reload/resume, only execution records are restored. An unknown outcome may have side effects; inspect evidence before deciding whether to start a new command. Commands are never automatically resumed or rerun.",
] as const;

export const BgBashSpawnInput = Type.Object(
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
export type BgBashSpawnParams = Static<typeof BgBashSpawnInput>;

export const BgBashIdParams = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description: "Background Bash job ID returned by bg_bash_spawn.",
		}),
	},
	{ additionalProperties: false },
);

export const BgBashGetParams = Type.Object(
	{
		id: BgBashIdParams.properties.id,
		keys: Type.Optional(
			Type.String({
				description:
					"Comma-separated fields: status, progress, diagnostic. Defaults to status,progress.",
			}),
		),
	},
	{ additionalProperties: false },
);

function branchAnchor(context: ExtensionContext): string | undefined {
	return context.sessionManager?.getLeafId?.() ?? undefined;
}

const BG_BASH_NAMESPACE = {
	name: "bg_bash",
	aliases: ["bg_bash", "background_bash", "bg-bash", "background-bash"],
	description: "Background Bash commands",
};

const MAX_PROGRESS_COMMAND_CHARS = 200;
const MAX_PROGRESS_OUTPUT_CHARS = 10_000;
const MAX_DIAGNOSTIC_CHARS = 2_000;

export function registerBgBashTools(pi: ExtensionAPI, state: BackgroundBashRuntimeState): void {
	const spawnBashTool: ToolDefinition<typeof BgBashSpawnInput, unknown> = {
		name: "bg_bash_spawn",
		...bgBashPresentationRenderers(pi, "bg_bash_spawn"),
		namespace: BG_BASH_NAMESPACE,
		label: "bg_bash_spawn",
		description: SPAWN_BASH_DESCRIPTION,
		promptSnippet: "Start a background shell command; terminal notification wakes a follow-up turn",
		promptGuidelines: [...SPAWN_BASH_PROMPT_GUIDELINES],
		parameters: BgBashSpawnInput,
		exposure: "deferred",
		defaultActive: false,
		annotations: {
			openWorldHint: true,
			destructiveHint: true,
		},
		async execute(
			_id: string,
			params: BgBashSpawnParams,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			context: ExtensionContext,
		) {
			// The schema rejects a caller-chosen id: the registry assigns it, so a log file is never reused.
			if (!Value.Check(BgBashSpawnInput, params))
				throw new Error("Invalid bg_bash_spawn parameters");
			// A NUL byte cannot survive argv, and rewriting it to `\0` guesses at shell syntax the target
			// program may not share. Refusing it keeps the caller's own escape intact.
			if (params.command.includes("\0"))
				throw new Error(
					"The command contains a NUL byte (U+0000), which cannot be passed to a shell. Write the " +
						"escape your target program expects (for example \\0 for printf or tr) instead.",
				);
			const settings = state?.getSettings();
			const jobs = state?.getBashJobs();
			if (settings === undefined || jobs === undefined)
				return {
					...textToolResult("Background Bash unavailable outside active session", undefined),
					isError: true,
				};
			const anchor = branchAnchor(context);
			const logDir = bashExecutionDirectory(context);
			try {
				mkdirSync(logDir, { recursive: true });
				const job = jobs.start({
					command: params.command,
					cwd: context.cwd,
					shellPath: settings.shellPath,
					background: true,
					resolveLogPath: (id: string) => join(logDir, `${id}.log`),
					...(anchor === undefined ? {} : { anchor }),
					...(params.timeout === undefined
						? isSearchOnlyCommand(params.command)
							? { timeoutMs: SEARCH_BASH_TIMEOUT_SECONDS * 1000 }
							: {}
						: { timeoutMs: Math.max(0, params.timeout * 1000) }),
				});
				// The log path is reported even when writing it failed, so the job can point at the
				// intended file; the recorded diagnostic tells the user why it may be empty.
				const path = job.logPath ?? join(logDir, `${job.id}.log`);
				return textToolResult(JSON.stringify({ id: job.id, path }), { id: job.id, path });
			} catch (error) {
				const msg = `Unable to start background job: ${errorMessage(error)}`;
				return { ...textToolResult(msg, undefined), isError: true };
			}
		},
	};
	pi.registerTool(spawnBashTool);

	const jobOf = (id: string) => {
		const jobs = state.getBashJobs();
		if (jobs === undefined) throw new Error("No active background Bash session");
		const job = jobs.get(id);
		if (job === undefined) throw new Error(`Background Bash task ${id} not found`);
		return job;
	};

	const get: ToolDefinition<typeof BgBashGetParams> = {
		name: "bg_bash_get",
		...bgBashPresentationRenderers(pi, "bg_bash_get"),
		label: "Get background Bash",
		namespace: BG_BASH_NAMESPACE,
		description:
			"Inspect background Bash runtime status, progress, or diagnostic details. Results return automatically; do not poll for completion. Related tools: bg_bash_spawn, bg_bash_stop.",
		parameters: BgBashGetParams,
		exposure: "deferred",
		defaultActive: false,
		annotations: { readOnlyHint: true, idempotentHint: true },
		async execute(_id, params) {
			const keys = [
				...new Set(
					(params.keys ?? "status,progress")
						.split(",")
						.map((key) => key.trim())
						.filter(Boolean),
				),
			];
			for (const key of keys) {
				if (key !== "status" && key !== "progress" && key !== "diagnostic")
					throw new Error(
						`Unknown bg_bash_get key "${key}". Allowed keys: status, progress, diagnostic.`,
					);
			}
			if (keys.length === 0) keys.push("status", "progress");
			const job = jobOf(params.id);
			const view: Record<string, unknown> = {};
			if (keys.includes("status")) view.status = job.status;
			if (keys.includes("progress")) {
				view.progress = {
					command: job.command.slice(0, MAX_PROGRESS_COMMAND_CHARS),
					cwd: job.cwd,
					...(job.status === "unknown"
						? {}
						: { elapsedSeconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000) }),
					...(job.logPath === undefined ? {} : { path: job.logPath }),
					...(!isTerminalBashStatus(job.status)
						? {
								output: job.output.slice(-MAX_PROGRESS_OUTPUT_CHARS),
								truncated: job.truncated || job.output.length > MAX_PROGRESS_OUTPUT_CHARS,
							}
						: {}),
				};
			}
			if (keys.includes("diagnostic") || job.status === "unknown") {
				const diagnostic = job.diagnostic ?? diagnosticFor(job);
				if (diagnostic !== undefined) view.diagnostic = diagnostic.slice(0, MAX_DIAGNOSTIC_CHARS);
			}
			return textToolResult(JSON.stringify(view), view);
		},
	};

	const stop: ToolDefinition<typeof BgBashIdParams> = {
		name: "bg_bash_stop",
		...bgBashPresentationRenderers(pi, "bg_bash_stop"),
		label: "Stop background Bash",
		namespace: BG_BASH_NAMESPACE,
		description:
			"Stop one background Bash process tree by ID and wait for the process to exit. Terminal result returns automatically. Related tools: bg_bash_spawn, bg_bash_stop.",
		parameters: BgBashIdParams,
		exposure: "deferred",
		defaultActive: false,
		annotations: { destructiveHint: true },
		async execute(_id, params, signal) {
			const jobs = state.getBashJobs();
			if (jobs === undefined) throw new Error("No active background Bash session");
			const current = jobs.get(params.id);
			if (current === undefined) throw new Error(`Background Bash task ${params.id} not found`);
			if (current.status === "unknown")
				return {
					...textToolResult(
						`Job ${params.id} has an unknown outcome. No process was adopted or signalled. Inspect its log and side effects before deciding next action.`,
						undefined,
					),
					isError: true,
				};
			if (isTerminalBashStatus(current.status))
				return textToolResult(`Job ${params.id} already finished.`, undefined);
			// Cancellation is a request; the confirmation reports the status the process actually reached.
			jobs.stop(params.id);
			// An interrupted call gives up waiting for the exit, but the registry keeps its stop request
			// and its sweep, so the tree the caller left behind is still cleaned up.
			const stopped = await jobs.waitFor(params.id, signal);
			if (stopped === undefined) throw new Error(`Stop of ${params.id} was interrupted.`);
			if (stopped.status === "unknown")
				return {
					...textToolResult(
						`Unable to confirm stop of ${stopped.id}. ${stopped.diagnostic ?? "Process cleanup could not be confirmed; side effects may remain."}`,
						undefined,
					),
					isError: true,
				};
			return textToolResult(`Stopped ${stopped.id}.`, undefined);
		},
	};

	pi.registerTool(get);
	pi.registerTool(stop);
}

/** The reason a finished job did not succeed, when the process itself reported no error text. */
function diagnosticFor(job: {
	readonly timedOut: boolean;
	readonly status: string;
	readonly exitCode: number | null;
}): string | undefined {
	if (job.timedOut) return "Command timed out";
	if (job.status === "failed" && job.exitCode !== null)
		return `Command exited with code ${String(job.exitCode)}`;
	return undefined;
}
