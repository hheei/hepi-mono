import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createToolTui,
	type ExtensionLifecycleContext,
	formatDuration,
	isTerminalTaskStatus,
	type ManagedToolRegistration,
	provideService,
	registerManagedTool,
	setManagedToolsActive,
	TASK_REGISTRY_SERVICE_KEY,
	TaskRegistry,
	type TaskSnapshot,
	type TaskStopOutcome,
	type TaskWaitOutcome,
	type ToolTui,
	textToolResult,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { startTaskDelivery } from "./task-delivery.js";

const OWNER = "@hheei/pi-ext-tools";

/** Task-control tools: registered for every session, activated only while control is needed. */
export const TASK_TOOL_REGISTRATIONS = [
	{ id: "list_tasks", owner: OWNER, defaultActive: false },
	{ id: "wait_tasks", owner: OWNER, defaultActive: false },
	{ id: "stop_tasks", owner: OWNER, defaultActive: false },
] as const satisfies readonly ManagedToolRegistration[];

export const TASK_TOOL_IDS: readonly string[] = TASK_TOOL_REGISTRATIONS.map(
	(registration) => registration.id,
);

/**
 * Creates the session's task registry, publishes it as a Service, and owns the activation
 * policy of the task-control tools plus parent-session notification.
 *
 * Pi activates every registered extension tool at session start and again after `/tree`
 * restores the transcript tool set, so the tools are re-deactivated whenever no task is
 * active and no result is still waiting for notification. The three tools must already be
 * registered through `registerTaskTools`.
 */
export function startTaskControl(context: ExtensionLifecycleContext): TaskRegistry {
	const setActive = (active: boolean): void => {
		const applied = context.pi.getActiveTools().some((id) => TASK_TOOL_IDS.includes(id));
		if (applied === active) return;
		setManagedToolsActive(context, TASK_TOOL_REGISTRATIONS, active);
	};
	const registry = new TaskRegistry({ onFirstTask: () => setActive(true) });
	setActive(false);
	const stopDelivery = startTaskDelivery({
		pi: context.pi,
		registry,
		session: context.extension,
		signal: context.signal,
		notify: (message, level) => context.extension.ui.notify(message, level),
	});
	if (!provideService(context, TASK_REGISTRY_SERVICE_KEY, registry)) {
		stopDelivery();
		registry.dispose();
		throw new Error("Another extension already provides the task registry service");
	}
	const onBoundary = (): void => {
		// Pi also re-activates every registered tool when /tree restores the transcript tool set, so a
		// boundary can mean either direction: control is dropped once nothing needs it, and restored
		// when a task or an undelivered result is still there.
		setActive(registry.requiresControl);
	};
	const unsubscribe = [
		context.pi.on("session_compact", onBoundary),
		context.pi.on("session_tree", onBoundary),
	];
	context.resources.add("task-control", () => {
		stopDelivery();
		for (const stop of unsubscribe) stop();
		registry.dispose();
	});
	return registry;
}

const NO_ACTIVE_TASK_SESSION = "No active task session";

function unavailable() {
	return textToolResult(NO_ACTIVE_TASK_SESSION, { error: "session_unavailable" });
}
const ID_DESCRIPTION =
	"Background task ids such as bash-1 or bash-22; single-task calls pass a one-element array.";
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

function deliveryMark(task: TaskSnapshot): string | undefined {
	if (task.delivery === undefined) return undefined;
	if (task.delivery === "observed") return "result in context";
	if (task.delivery === "submitted") return "result sent, unconfirmed";
	return "result not sent";
}

function taskLine(task: TaskSnapshot): string {
	const marks = [elapsed(task.startedAt, task.endedAt), deliveryMark(task)];
	return `${task.id} ${task.status} · ${task.purpose} (${marks.filter(Boolean).join(" · ")})`;
}

function listText(tasks: readonly TaskSnapshot[], includeTerminal: boolean): string {
	if (tasks.length === 0)
		return includeTerminal ? "No background tasks." : "No active background tasks.";
	// A task that was asked to stop has not stopped yet, so the count is of active work, not of runs.
	const active = tasks.filter((task) => !isTerminalTaskStatus(task.status)).length;
	const heading = includeTerminal
		? `${tasks.length} background tasks (${active} active):`
		: `${active} active background tasks:`;
	return [heading, ...tasks.map(taskLine)].join("\n");
}

function waitText(outcomes: readonly TaskWaitOutcome[]): string {
	return outcomes
		.map((outcome) => {
			if (outcome.status === "not_found") return `${outcome.id} not_found`;
			const settled = isTerminalTaskStatus(outcome.status);
			const state = settled ? outcome.status : "still running";
			const marks = [
				...(outcome.waited ? [] : ["wait cancelled"]),
				...(outcome.delivery === "observed" ? ["already in context"] : []),
				...(outcome.delivery === "pending" || outcome.delivery === "submitted"
					? ["notification not confirmed in context"]
					: []),
				...(outcome.truncated ? ["truncated"] : []),
			];
			const suffix = marks.length === 0 ? "" : ` (${marks.join(", ")})`;
			return `${outcome.id} ${state}${suffix}:\n${outcome.output === "" ? "(no output)" : outcome.output}`;
		})
		.join("\n\n");
}

function stopText(outcomes: readonly TaskStopOutcome[]): string {
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
	const getRegistry = (): TaskRegistry | undefined => state.getTasks();
	const listTool: ToolDefinition<typeof ListParams, unknown> = {
		name: "list_tasks",
		label: "list_tasks",
		description: "List background tasks started in this session.",
		parameters: ListParams,
		defaultActive: false,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
		},
		async execute(_id, params: ListInput) {
			const tasks = getRegistry();
			if (tasks === undefined) return unavailable();
			const listed = tasks.list(params.includeTerminal === true);
			return textToolResult(listText(listed, params.includeTerminal === true), {
				tasks: listed,
			});
		},
	};
	const waitTool: ToolDefinition<typeof IdsParams, unknown> = {
		name: "wait_tasks",
		label: "wait_tasks",
		description:
			"Wait until every listed background task finishes and return their results directly. This does not consume the automatic completion notification.",
		promptGuidelines: [
			"Do not poll background tasks. Use `wait_tasks` only when the next step needs their results.",
		],
		parameters: IdsParams,
		defaultActive: false,
		annotations: {
			readOnlyHint: true,
			idempotentHint: false,
		},
		async execute(_id, params: IdsInput, signal) {
			const tasks = getRegistry();
			if (tasks === undefined) return unavailable();
			const ids = readIds(params.ids);
			if (ids === undefined)
				return {
					...textToolResult("wait_tasks needs at least one task id.", { error: "invalid_ids" }),
					isError: true,
				};
			const outcomes = await tasks.wait(ids, signal);
			const cancelled = outcomes.some(
				(outcome) => outcome.status !== "not_found" && !outcome.waited,
			);
			return {
				...textToolResult(waitText(outcomes), {
					tasks: outcomes,
					...(cancelled ? { error: "wait_cancelled" } : {}),
				}),
				...(cancelled ? { isError: true } : {}),
			};
		},
	};
	const stopTool: ToolDefinition<typeof IdsParams, unknown> = {
		name: "stop_tasks",
		label: "stop_tasks",
		description: "Stop listed background tasks. Stopping an already finished task is harmless.",
		promptGuidelines: ["Stop background tasks when their results are no longer needed."],
		parameters: IdsParams,
		defaultActive: false,
		annotations: {
			destructiveHint: true,
		},
		async execute(_id, params: IdsInput) {
			const tasks = getRegistry();
			if (tasks === undefined) return unavailable();
			const ids = readIds(params.ids);
			if (ids === undefined)
				return {
					...textToolResult("stop_tasks needs at least one task id.", { error: "invalid_ids" }),
					isError: true,
				};
			const outcomes = tasks.stop(ids);
			return textToolResult(stopText(outcomes), { tasks: outcomes });
		},
	};
	const [listRegistration, waitRegistration, stopRegistration] = TASK_TOOL_REGISTRATIONS;
	registerManagedTool(
		pi,
		listRegistration,
		tui.frame(listTool, {
			summary: (args) => (args.includeTerminal ? "all" : "active"),
			headerLine: "truncate",
			footer: (result) => {
				const details = result.details as { readonly tasks?: readonly TaskSnapshot[] } | undefined;
				if (!Array.isArray(details?.tasks)) return undefined;
				const count = details.tasks.length;
				return count === 1 ? "1 task" : `${count} tasks`;
			},
		}),
	);
	registerManagedTool(
		pi,
		waitRegistration,
		tui.frame(waitTool, {
			summary: (args) => args.ids.join(" "),
			summarySeparator: "space",
			headerLine: "truncate",
			footer: (result, completion) => {
				const details = result.details as
					| { readonly tasks?: readonly TaskWaitOutcome[] }
					| undefined;
				if (!Array.isArray(details?.tasks)) return undefined;
				const count = details.tasks.length;
				const taskText = count === 1 ? "1 task" : `${count} tasks`;
				const duration = formatDuration(completion?.durationMs);
				return [taskText, duration].filter(Boolean).join(" · ");
			},
		}),
	);
	registerManagedTool(
		pi,
		stopRegistration,
		tui.frame(stopTool, {
			summary: (args) => args.ids.join(" "),
			summarySeparator: "space",
			headerLine: "truncate",
			footer: (result) => {
				const details = result.details as
					| { readonly tasks?: readonly TaskStopOutcome[] }
					| undefined;
				if (!Array.isArray(details?.tasks) || details.tasks.length === 0) return undefined;
				const count = details.tasks.length;
				return count === 1 ? "1 task" : `${count} tasks`;
			},
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
