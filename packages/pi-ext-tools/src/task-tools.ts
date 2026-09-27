import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createToolTui,
	type ExtensionLifecycleContext,
	type ManagedToolRegistration,
	registerManagedTool,
	setManagedToolsActive,
	type ToolTui,
	textToolResult,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import {
	AsyncTaskRegistry,
	type AsyncTaskSnapshot,
	type AsyncTaskStopOutcome,
	type AsyncTaskWaitOutcome,
} from "./tasks/registry.js";

const OWNER = "@hheei/pi-ext-tools";

/** Task-control tools: registered for every session, activated only when tasks exist. */
export const TASK_TOOL_REGISTRATIONS = [
	{ id: "list_tasks", owner: OWNER },
	{ id: "wait_tasks", owner: OWNER },
	{ id: "stop_tasks", owner: OWNER },
] as const satisfies readonly ManagedToolRegistration[];

export const TASK_TOOL_IDS: readonly string[] = TASK_TOOL_REGISTRATIONS.map(
	(registration) => registration.id,
);

/**
 * Creates the session's task registry and owns the activation policy of its tools.
 *
 * Pi activates every registered extension tool at session start and again after `/tree`
 * restores the transcript tool set, so the initial deactivation must really run: the
 * applied state is read back from `pi.getActiveTools()` instead of a local flag. Tools
 * stay active between turns so a finished task keeps a readable result, and are removed
 * only at a macro boundary once nothing is running. The three tools must already be
 * registered through `registerTaskTools`.
 */
export function startTaskControl(context: ExtensionLifecycleContext): AsyncTaskRegistry {
	const setActive = (active: boolean): void => {
		const applied = context.pi.getActiveTools().some((id) => TASK_TOOL_IDS.includes(id));
		if (applied === active) return;
		setManagedToolsActive(context, TASK_TOOL_REGISTRATIONS, active);
	};
	const tasks = new AsyncTaskRegistry({
		pi: context.pi,
		onFirstTask: () => setActive(true),
	});
	setActive(false);
	const onBoundary = (): void => {
		if (tasks.runningCount === 0) setActive(false);
	};
	const unsubscribe = [
		context.pi.on("session_compact", onBoundary),
		context.pi.on("session_tree", onBoundary),
	];
	context.resources.add("task-tool-boundary-listeners", () => {
		for (const stop of unsubscribe) stop();
	});
	return tasks;
}

const NO_ACTIVE_TASK_SESSION = "No active task session";

function unavailable(): AgentToolResult<{ readonly error: string }> {
	return textToolResult(NO_ACTIVE_TASK_SESSION, { error: "session_unavailable" });
}
const ID_DESCRIPTION =
	"Background task ids such as bash-1; single-task calls pass a one-element array.";
const Ids = Type.Array(Type.String({ minLength: 1 }), {
	minItems: 1,
	maxItems: 32,
	description: ID_DESCRIPTION,
});

const ListParams = Type.Object(
	{
		includeTerminal: Type.Optional(
			Type.Boolean({ description: "Also list tasks that already finished." }),
		),
	},
	{ additionalProperties: false },
);
const IdsParams = Type.Object({ ids: Ids }, { additionalProperties: false });
type ListInput = Static<typeof ListParams>;
type IdsInput = Static<typeof IdsParams>;

function elapsed(startedAt: number, endedAt: number | undefined): string {
	const seconds = Math.max(0, ((endedAt ?? Date.now()) - startedAt) / 1000);
	return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

/** Strict providers may send null or malformed entries for a declared array. */
function readIds(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids = value.filter((id): id is string => typeof id === "string" && id.trim() !== "");
	return ids.length === 0 ? undefined : ids;
}

function taskLine(task: AsyncTaskSnapshot): string {
	const marks = [
		elapsed(task.startedAt, task.endedAt),
		...(task.status === "running"
			? []
			: [task.delivered ? "result delivered" : "result not delivered"]),
	];
	return `${task.id} ${task.status} · ${task.purpose} (${marks.join(" · ")})`;
}

function listText(tasks: readonly AsyncTaskSnapshot[], includeTerminal: boolean): string {
	if (tasks.length === 0)
		return includeTerminal ? "No background tasks." : "No running background tasks.";
	const running = tasks.filter((task) => task.status === "running").length;
	const heading = includeTerminal
		? `${tasks.length} background tasks (${running} running):`
		: `${running} running background tasks:`;
	return [heading, ...tasks.map(taskLine)].join("\n");
}

function waitText(outcomes: readonly AsyncTaskWaitOutcome[]): string {
	return outcomes
		.map((outcome) => {
			if (outcome.status === "not_found") return `${outcome.id} not_found`;
			const settled = outcome.status !== "running";
			const state = settled ? outcome.status : "still running";
			const marks = [
				...(settled ? [] : ["wait cancelled"]),
				...(outcome.delivered ? ["already in context"] : []),
				...(outcome.truncated ? ["truncated"] : []),
			];
			const suffix = marks.length === 0 ? "" : ` (${marks.join(", ")})`;
			return `${outcome.id} ${state}${suffix}:\n${outcome.output === "" ? "(no output)" : outcome.output}`;
		})
		.join("\n\n");
}

function stopText(outcomes: readonly AsyncTaskStopOutcome[]): string {
	return outcomes
		.map((outcome) => {
			if (outcome.status === "stop_requested") return `${outcome.id} stop requested`;
			if (outcome.status === "already_terminal") return `${outcome.id} already finished`;
			if (outcome.status === "stop_failed") return `${outcome.id} stop failed; it keeps running`;
			return `${outcome.id} not_found`;
		})
		.join("\n");
}

export function registerTaskTools(
	pi: ExtensionAPI,
	state: FffRuntimeState,
	tui: ToolTui = createToolTui(),
): void {
	const listTool: ToolDefinition<typeof ListParams, unknown> = {
		name: "list_tasks",
		label: "list_tasks",
		description: "List background tasks started in this session.",
		parameters: ListParams,
		async execute(_id, params: ListInput) {
			const tasks = state.getTasks();
			if (tasks === undefined) return unavailable();
			const listed = tasks.list(params.includeTerminal === true);
			return textToolResult(listText(listed, params.includeTerminal === true), {
				tasks: listed.map((task) => ({
					id: task.id,
					type: task.type,
					status: task.status,
					purpose: task.purpose,
					startedAt: task.startedAt,
					delivered: task.delivered,
					...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
				})),
			});
		},
	};
	const waitTool: ToolDefinition<typeof IdsParams, unknown> = {
		name: "wait_tasks",
		label: "wait_tasks",
		description: "Wait until every listed background task finishes and return their results.",
		promptGuidelines: [
			"Do not poll background tasks. Use `wait_tasks` only when the next step needs their results.",
		],
		parameters: IdsParams,
		async execute(_id, params: IdsInput, signal) {
			const tasks = state.getTasks();
			if (tasks === undefined) return unavailable();
			const ids = readIds(params.ids);
			if (ids === undefined)
				return textToolResult("wait_tasks needs at least one task id.", { error: "invalid_ids" });
			const outcomes = await tasks.wait(ids, signal);
			const cancelled = outcomes.some((outcome) => outcome.status === "running");
			return textToolResult(waitText(outcomes), {
				tasks: outcomes.map((outcome) =>
					outcome.status === "not_found"
						? { id: outcome.id, status: outcome.status }
						: {
								id: outcome.id,
								status: outcome.status,
								waited: outcome.waited,
								delivered: outcome.delivered,
								truncated: outcome.truncated,
								output: outcome.output,
							},
				),
				...(cancelled ? { error: "wait_cancelled" } : {}),
			});
		},
	};
	const stopTool: ToolDefinition<typeof IdsParams, unknown> = {
		name: "stop_tasks",
		label: "stop_tasks",
		description: "Stop listed background tasks. Stopping an already finished task is harmless.",
		promptGuidelines: ["Stop background tasks when their results are no longer needed."],
		parameters: IdsParams,
		async execute(_id, params: IdsInput) {
			const tasks = state.getTasks();
			if (tasks === undefined) return unavailable();
			const ids = readIds(params.ids);
			if (ids === undefined)
				return textToolResult("stop_tasks needs at least one task id.", { error: "invalid_ids" });
			const outcomes = tasks.stop(ids);
			return textToolResult(stopText(outcomes), { tasks: outcomes });
		},
	};
	const [listRegistration, waitRegistration, stopRegistration] = TASK_TOOL_REGISTRATIONS;
	registerManagedTool(pi, listRegistration, tui.frame(listTool));
	registerManagedTool(
		pi,
		waitRegistration,
		tui.frame(waitTool, {
			summary: (args) => args.ids.join(" "),
			summarySeparator: "space",
		}),
	);
	registerManagedTool(
		pi,
		stopRegistration,
		tui.frame(stopTool, {
			summary: (args) => args.ids.join(" "),
			summarySeparator: "space",
			warning: (result) => stopWarning(result.details),
		}),
	);
}

function stopWarning(details: unknown): boolean {
	if (typeof details !== "object" || details === null) return false;
	const tasks = (details as { readonly tasks?: unknown }).tasks;
	if (!Array.isArray(tasks)) return false;
	return tasks.some((task) => {
		if (typeof task !== "object" || task === null) return false;
		const status = (task as { readonly status?: unknown }).status;
		return status === "stop_failed" || status === "not_found";
	});
}
