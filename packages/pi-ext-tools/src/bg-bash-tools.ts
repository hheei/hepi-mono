import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { errorMessage, isTerminalTaskStatus, textToolResult } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { isSearchOnlyCommand, SEARCH_BASH_TIMEOUT_SECONDS } from "./bash-search.js";
import { bgBashPresentationRenderers } from "./bg-bash-presentation.js";
import type { ToolsRuntimeState } from "./session-state.js";

export const BG_BASH_TOOL_NAMES = ["bg_bash_spawn", "bg_bash_get", "bg_bash_stop"] as const;
export const BG_BASH_TASK_TOOL_IDS: readonly string[] = ["bg_bash_get", "bg_bash_stop"];
export const TASK_TOOL_IDS = BG_BASH_TASK_TOOL_IDS;

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

const SPAWN_BASH_DESCRIPTION =
	"Start a shell command in the background as a task and return JSON { id, path }, where path is the absolute log file path. The terminal result is delivered automatically via <task-notice> when the command finishes. Related background task tools: bg_bash_get, bg_bash_stop.";
const SPAWN_BASH_PROMPT_GUIDELINES = [
	"Use bg_bash_spawn for commands that run for a long time (tests, builds, dev servers, watchers).",
	"bg_bash_spawn returns JSON { id, path }, where path is the absolute log file path. Terminal completion is delivered via <task-notice> and automatically wakes a follow-up turn.",
	"After calling bg_bash_spawn, yield the turn or continue other independent work. Do NOT poll or sleep merely to wait for completion.",
	"Read or grep the returned path for full output; bg_bash_get progress.path provides the same path.",
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
export const SpawnBashInput = BgBashSpawnInput;
export type BgBashSpawnParams = Static<typeof BgBashSpawnInput>;

export const BgBashIdParams = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description: "Background Bash task ID returned by bg_bash_spawn.",
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

function taskAnchor(context: ExtensionContext): string | undefined {
	return context.sessionManager?.getLeafId?.() ?? undefined;
}

export function registerBgBashTools(pi: ExtensionAPI, state: ToolsRuntimeState): void {
	const spawnBashTool: ToolDefinition<typeof BgBashSpawnInput, unknown> = {
		name: "bg_bash_spawn",
		...bgBashPresentationRenderers(pi, "bg_bash_spawn"),
		namespace: { name: "bg_bash", description: "Background Bash commands" },
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
			const validatedParams = params;
			if (!Value.Check(BgBashSpawnInput, validatedParams))
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
					resolveLogPath: (taskId: string) => join(logDir, `${taskId}.log`),
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

	const getTask = (id: string) => {
		const tasks = state.getTasks();
		if (tasks === undefined) throw new Error("No active background Bash session");
		const task = tasks.get(id);
		if (task === undefined || task.type !== "bash")
			throw new Error(`Background Bash task ${id} not found`);
		return { tasks, task };
	};

	const get: ToolDefinition<typeof BgBashGetParams> = {
		name: "bg_bash_get",
		...bgBashPresentationRenderers(pi, "bg_bash_get"),
		label: "Get background Bash",
		namespace: { name: "bg_bash", description: "Background Bash commands" },
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
			const { task } = getTask(params.id);
			const job = state.getBashJobs()?.get(params.id);
			const path = job?.logPath;
			const view: Record<string, unknown> = {};
			if (keys.includes("status")) view.status = task.status;
			if (keys.includes("progress")) {
				view.progress = {
					command: job?.command.slice(0, 200) ?? task.purpose,
					...(job === undefined
						? {}
						: {
								cwd: job.cwd,
								elapsedSeconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
							}),
					...(path === undefined ? {} : { path }),
					...(!isTerminalTaskStatus(task.status) && job?.status === "running"
						? {
								output: job.output.slice(-10_000),
								truncated: job.truncated || job.output.length > 10_000,
							}
						: {}),
				};
			}
			if (keys.includes("diagnostic")) {
				const diagnostic = job?.timedOut
					? "Command timed out"
					: (job?.diagnostic ??
						(job?.status === "failed" && job.exitCode !== null
							? `Command exited with code ${job.exitCode}`
							: undefined));
				if (diagnostic !== undefined) view.diagnostic = diagnostic.slice(0, 2000);
			}
			return textToolResult(JSON.stringify(view), view);
		},
	};

	const stop: ToolDefinition<typeof BgBashIdParams> = {
		name: "bg_bash_stop",
		...bgBashPresentationRenderers(pi, "bg_bash_stop"),
		label: "Stop background Bash",
		namespace: { name: "bg_bash", description: "Background Bash commands" },
		description:
			"Stop one background Bash process tree by ID. Terminal result returns automatically. Related tools: bg_bash_spawn, bg_bash_get.",
		parameters: BgBashIdParams,
		exposure: "deferred",
		defaultActive: false,
		annotations: { destructiveHint: true },
		async execute(_id, params) {
			const { tasks } = getTask(params.id);
			const outcomes = tasks.stop([params.id]);
			if (outcomes.some((outcome) => outcome.status === "stop_failed"))
				throw new Error("Unable to stop background Bash task.");
			return textToolResult(
				outcomes.some((outcome) => outcome.status === "already_terminal")
					? "Task already finished."
					: "Stop requested.",
				undefined,
			);
		},
	};

	pi.registerTool(get);
	pi.registerTool(stop);
}

export const registerTaskTools = registerBgBashTools;
