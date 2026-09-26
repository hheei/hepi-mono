import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createToolTui, registerManagedLoadoutTool, type ToolTui } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import type {
	AsyncTaskSnapshot,
	AsyncTaskStopOutcome,
	AsyncTaskWaitOutcome,
} from "./tasks/registry.js";

const OWNER = "@hheei/pi-ext-tools";
const NO_ACTIVE_TASK_SESSION = "No active task session";

function unavailable(): AgentToolResult<{ readonly error: string }> {
	return {
		content: [{ type: "text", text: NO_ACTIVE_TASK_SESSION }],
		details: { error: "session_unavailable" },
	};
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
			return {
				content: [{ type: "text", text: listText(listed, params.includeTerminal === true) }],
				details: {
					tasks: listed.map((task) => ({
						id: task.id,
						type: task.type,
						status: task.status,
						purpose: task.purpose,
						startedAt: task.startedAt,
						delivered: task.delivered,
						...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
					})),
				},
			};
		},
	};
	const waitTool: ToolDefinition<typeof IdsParams, unknown> = {
		name: "wait_tasks",
		label: "wait_tasks",
		description:
			"Wait until every listed background task finishes and return their results. Use it when the next step needs those results; do not poll for them.",
		parameters: IdsParams,
		async execute(_id, params: IdsInput, signal) {
			const tasks = state.getTasks();
			if (tasks === undefined) return unavailable();
			const ids = readIds(params.ids);
			if (ids === undefined)
				return {
					content: [{ type: "text", text: "wait_tasks needs at least one task id." }],
					details: { error: "invalid_ids" },
				};
			const outcomes = await tasks.wait(ids, signal);
			const cancelled = outcomes.some((outcome) => outcome.status === "running");
			return {
				content: [{ type: "text", text: waitText(outcomes) }],
				details: {
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
				},
			};
		},
	};
	const stopTool: ToolDefinition<typeof IdsParams, unknown> = {
		name: "stop_tasks",
		label: "stop_tasks",
		description: "Stop listed background tasks. Stopping an already finished task is harmless.",
		parameters: IdsParams,
		async execute(_id, params: IdsInput) {
			const tasks = state.getTasks();
			if (tasks === undefined) return unavailable();
			const ids = readIds(params.ids);
			if (ids === undefined)
				return {
					content: [{ type: "text", text: "stop_tasks needs at least one task id." }],
					details: { error: "invalid_ids" },
				};
			const outcomes = tasks.stop(ids);
			return {
				content: [{ type: "text", text: stopText(outcomes) }],
				details: { tasks: outcomes },
			};
		},
	};
	registerManagedLoadoutTool(
		pi,
		{
			id: "list_tasks",
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tui.frame(listTool),
	);
	registerManagedLoadoutTool(
		pi,
		{
			id: "wait_tasks",
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
		tui.frame(waitTool, {
			summary: (args) => args.ids.join(" "),
			summarySeparator: "space",
		}),
	);
	registerManagedLoadoutTool(
		pi,
		{
			id: "stop_tasks",
			owner: OWNER,
			group: "Built-in",
			origin: OWNER,
			priority: 100,
			conflictSets: [],
			defaultActive: true,
		},
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
