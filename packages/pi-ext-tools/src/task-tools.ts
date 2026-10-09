import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	isTerminalTaskStatus,
	provideService,
	setSessionToolsActive,
	TASK_REGISTRY_SERVICE_KEY,
	TaskRegistry,
	type TaskSnapshot,
	type TaskStopOutcome,
	type TaskWaitOutcome,
	textToolResult,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import type { FffRuntimeState } from "./fff/lifecycle.js";
import { startTaskDelivery } from "./task-delivery.js";

/** Job-control tools: registered for every session, activated only while control is needed. */
export const TASK_TOOL_IDS: readonly string[] = ["list_jobs", "wait_jobs", "stop_jobs"];

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
		const activeTools = context.pi.getActiveTools();
		const applied = TASK_TOOL_IDS.some((id) => activeTools.includes(id));
		if (applied === active) return;
		setSessionToolsActive(context, TASK_TOOL_IDS, active);
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
	"Background job ids such as bash-1 or agent-1; single-job calls pass a one-element array. Subagent ids use the same agent-X format returned by spawn_agent.";
const Ids = Type.Array(Type.String({ minLength: 1 }), {
	minItems: 1,
	maxItems: 32,
	description: ID_DESCRIPTION,
});

const ListParams = Type.Object(
	{
		includeTerminal: Type.Optional(
			Type.Boolean({ description: "Also list jobs that already finished." }),
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
		return includeTerminal ? "No background jobs." : "No active background jobs.";
	// A job that was asked to stop has not stopped yet, so the count is of active work, not of runs.
	const active = tasks.filter((task) => !isTerminalTaskStatus(task.status)).length;
	const heading = includeTerminal
		? `${tasks.length} background jobs (${active} active):`
		: `${active} active background jobs:`;
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

export function registerTaskTools(pi: ExtensionAPI, state: FffRuntimeState): void {
	const getRegistry = (): TaskRegistry | undefined => state.getTasks();
	const listTool: ToolDefinition<typeof ListParams, unknown> = {
		name: "list_jobs",
		label: "list_jobs",
		description: "List background jobs started in this session.",
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
		name: "wait_jobs",
		label: "wait_jobs",
		description:
			"Wait until every listed background job finishes (timeout: 1800s) and return their results directly. Do not poll background jobs. Use this only when the next step needs their results.",
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
					...textToolResult("wait_jobs needs at least one job id.", { error: "invalid_ids" }),
					isError: true,
				};

			const timeoutController = new AbortController();
			let timedOut1800 = false;
			const timeoutTimer = setTimeout(() => {
				timedOut1800 = true;
				timeoutController.abort();
			}, 1800 * 1000);

			const onSignalAbort = () => timeoutController.abort();
			signal?.addEventListener("abort", onSignalAbort, { once: true });

			let outcomes: readonly TaskWaitOutcome[];
			try {
				outcomes = await tasks.wait(ids, timeoutController.signal);
			} finally {
				clearTimeout(timeoutTimer);
				signal?.removeEventListener("abort", onSignalAbort);
			}

			if (timedOut1800) {
				const stillRunning = outcomes
					.filter(
						(outcome) => outcome.status !== "not_found" && !isTerminalTaskStatus(outcome.status),
					)
					.map((outcome) => outcome.id);
				const checkpointNotice = `工作仍在进行中（已等待 1800 秒，涉及：${stillRunning.join(", ")}）。请确定工作状态是否正常再继续进行 wait_jobs，或调用 stop_jobs 终止。`;
				return {
					...textToolResult(`${checkpointNotice}\n\n${waitText(outcomes)}`, {
						tasks: outcomes,
						timedOut: true,
						error: "wait_jobs_timeout",
					}),
					isError: true,
				};
			}

			const settledIds = outcomes
				.filter(
					(outcome) =>
						outcome.status !== "not_found" &&
						isTerminalTaskStatus(outcome.status) &&
						outcome.waited,
				)
				.map((outcome) => outcome.id);
			if (settledIds.length > 0 && typeof tasks.markConsumed === "function") {
				tasks.markConsumed(settledIds);
			}

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
		name: "stop_jobs",
		label: "stop_jobs",
		description:
			"Stop listed background jobs when their results are no longer needed. Stopping an already finished job is harmless.",
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
					...textToolResult("stop_jobs needs at least one job id.", { error: "invalid_ids" }),
					isError: true,
				};
			const outcomes = tasks.stop(ids);
			return textToolResult(stopText(outcomes), { tasks: outcomes });
		},
	};
	pi.registerTool({ ...listTool, defaultActive: false });
	pi.registerTool({ ...waitTool, defaultActive: false });
	pi.registerTool({ ...stopTool, defaultActive: false });
}
