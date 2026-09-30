/**
 * The unified `task` entry point.
 *
 * `task` is a background-task producer, not a second subagent front end: its result lands in the
 * same registry, the same `wait_tasks` reads and the same notification window as a background
 * Bash command. It requires the shared task registry, which `@hheei/pi-ext-tools` provides, and
 * stays inactive with an explicit reason when that integration is not installed.
 */
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	errorMessage,
	isRecord,
	registerManagedTool,
	setManagedToolsActive,
	TASK_REGISTRY_SERVICE_KEY,
	type TaskRegistry,
	type TaskWaitOutcome,
	type ToolTui,
	textToolResult,
	waitForService,
} from "@hheei/pi-ext-core";
import { Type } from "typebox";
import type { TaskChildContract } from "./domain.js";
import type { AgentTaskExecutor } from "./task-executor.js";
import { DEFAULT_TASK_SOFT_TURNS } from "./task-result.js";
import { checkOutputSchema } from "./task-schema.js";

export const TASK_TOOL_ID = "task";
const OWNER = "@hheei/pi-subagents";
const TASK_TOOL_REGISTRATION = {
	id: TASK_TOOL_ID,
	owner: OWNER,
	defaultActive: false,
} as const;

const taskSchema = Type.Object({
	agent: Type.String({
		minLength: 1,
		description: "Agent definition to run, for example scout (read-only) or a definition you wrote",
	}),
	task: Type.String({ minLength: 1, description: "What this delegation must accomplish" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child" })),
	blocking: Type.Optional(
		Type.Boolean({
			description:
				"true (default) waits for the result in this call; pass false only to start a background task and return its id instead",
		}),
	),
	outputSchema: Type.Optional(
		Type.Unknown({
			description: "JSON Schema the final result must validate against; omit for a text result",
		}),
	),
});

const DESCRIPTION =
	"Run one delegated task as a dedicated agent execution. Waits for the result in this call and returns it; pass blocking: false to start a background task and get its id back immediately instead, then read the result with wait_tasks or let the automatic notification bring it back. The child is dedicated to this task and is terminated once it submits a final result, so use spawn_agent when you need a reusable conversation partner instead.";

const GUIDELINES = [
	"The default waits for the result, which is what a code review, an audit, a verification pass or a scout's reconnaissance needs before you can continue.",
	"Pass `blocking: false` only for work that can outlive this call: it starts a background task, and you should keep working until its result arrives as a notification.",
	"A blocking call reports its result only here, so do not wait for a notification as well.",
	"Do not poll wait_tasks for a task you started with blocking: false. The automatic notification starts your next turn.",
	"Set outputSchema when you need a machine-readable result instead of prose.",
];

const UNAVAILABLE =
	"The task integration is unavailable: this session has no shared background-task registry. Install @hheei/pi-ext-tools to enable it, or use spawn_agent for conversation-style delegation.";

/**
 * Registers `task` in a deactivated state and activates it when the shared task registry becomes
 * available. Activation is a continuation: the serial session-start handler must not wait for
 * another extension's provider.
 */
export function registerTaskTool(
	context: ExtensionLifecycleContext,
	tui: ToolTui,
	createExecutor: (registry: TaskRegistry) => AgentTaskExecutor,
): void {
	const pi: ExtensionAPI = context.pi;
	let active: { readonly registry: TaskRegistry; readonly executor: AgentTaskExecutor } | undefined;
	// Starts as the installation-boundary message and becomes the real failure reason if the
	// integration was found but could not start.
	let unavailable = UNAVAILABLE;
	const tool: ToolDefinition<typeof taskSchema> = {
		name: TASK_TOOL_ID,
		label: "Run task",
		description: DESCRIPTION,
		promptSnippet:
			"Run one delegated task as a background agent execution; the result arrives as a task result.",
		promptGuidelines: [...GUIDELINES],
		parameters: taskSchema,
		defaultActive: false,
		async execute(
			_id,
			params,
			signal,
			_onUpdate,
			context,
		): Promise<ReturnType<typeof textToolResult>> {
			const integration = active;
			if (integration === undefined) throw new Error(unavailable);
			const contract = taskContract(params.outputSchema);
			const anchor = taskAnchor(context);
			// Waiting is the default: a delegated task is usually the step you needed to take next,
			// and only an explicit false says the result can arrive after this call.
			const block = params.blocking !== false;
			let started: ReturnType<AgentTaskExecutor["start"]>;
			try {
				started = integration.executor.start({
					agent: params.agent,
					task: params.task,
					...(params.cwd === undefined ? {} : { cwd: params.cwd }),
					...(block ? { inlineResult: true } : {}),
					...(anchor === undefined ? {} : { anchor }),
					contract,
				});
			} catch (error) {
				throw new Error(`Task was not accepted: ${errorMessage(error)}`);
			}
			if (!block) {
				const idLabel =
					started.shortId === started.id ? started.id : `${started.shortId} (${started.id})`;
				return textToolResult(
					`Started ${idLabel}. Its result is added to the context after the notification window; read it earlier with wait_tasks ${started.id}.`,
					{ id: started.id, shortId: started.shortId, status: started.status },
				);
			}
			// A cancelled blocking call owns its execution, so cancelling must stop the task rather
			// than leave it running unobserved. It also gives up the result it was going to report:
			// this call returns now, so a result the execution still produces (or produced just before
			// the interruption) has to reach the parent through the background channel instead.
			const stopOnAbort = (): void => {
				integration.registry.releaseInlineResult(started.id);
				integration.executor.stop(started.id);
			};
			// An abort that already happened fires no event, so it is checked before listening.
			if (signal?.aborted === true) stopOnAbort();
			else signal?.addEventListener("abort", stopOnAbort, { once: true });
			let outcomes: readonly TaskWaitOutcome[];
			try {
				outcomes = await integration.registry.wait([started.id], signal);
			} finally {
				signal?.removeEventListener("abort", stopOnAbort);
			}
			const interrupted = signal?.aborted === true;
			const text = interrupted
				? `This call was interrupted, so ${started.shortId} was stopped instead of waited for. Its outcome is reported as a background task result.\n${formatBlockingOutcome(started.shortId, outcomes)}`
				: formatBlockingOutcome(started.shortId, outcomes);
			return textToolResult(text, outcomes);
		},
	};
	registerManagedTool(
		pi,
		TASK_TOOL_REGISTRATION,
		tui.frame(tool, {
			// The task text can be long, so only its first line is shown and the frame truncates it.
			summary: (args) => `${args.agent} \u00b7 ${firstLine(args.task)}`,
			// The registry owns the abbreviation; re-deriving it here would duplicate the id format.
			footer: (result) => taskFooter(active?.registry, result),
			headerLine: "truncate",
		}),
	);
	void waitForService(pi, TASK_REGISTRY_SERVICE_KEY, { signal: context.signal })
		.then((registry) => {
			if (context.signal.aborted) return;
			const executor = createExecutor(registry);
			active = { registry, executor };
			context.resources.add("subagent-task-executor", () => {
				active = undefined;
				executor.dispose();
			});
			setManagedToolsActive(context, [TASK_TOOL_REGISTRATION], true);
		})
		.catch((error: unknown) => {
			// No provider in this session, or the integration failed after one appeared; either way
			// the tool stays inactive and reports the cause it actually saw.
			unavailable = `The task integration is unavailable: ${errorMessage(error)}`;
		});
}

/**
 * Branch marker for a task that starts from a tool call. `undefined` when the session has no entry
 * yet, which the delivery adapter treats as always deliverable.
 */
function taskAnchor(context: ExtensionContext): string | undefined {
	return context.sessionManager.getLeafId() ?? undefined;
}

/** Validates the caller's schema before any process exists. */
function taskContract(schema: unknown): TaskChildContract {
	if (schema === undefined) return { softTurns: DEFAULT_TASK_SOFT_TURNS };
	const reason = checkOutputSchema(schema);
	if (reason !== undefined) throw new Error(`Unsupported outputSchema: ${reason}`);
	return { schema, softTurns: DEFAULT_TASK_SOFT_TURNS };
}

/** Typed footer: the task's short id and the status it actually reached. */
function taskFooter(
	registry: TaskRegistry | undefined,
	result: AgentToolResult<unknown>,
): string | undefined {
	const details: unknown = result.details;
	if (Array.isArray(details)) {
		const settled: unknown = details[0];
		if (!isRecord(settled) || typeof settled.id !== "string") return undefined;
		if (typeof settled.status !== "string") return undefined;
		// The status is the one this call actually observed; only the abbreviation comes from the
		// registry, which owns the id format.
		const task = registry?.get(settled.id);
		return task === undefined ? undefined : `${task.shortId} \u00b7 ${settled.status}`;
	}
	if (isRecord(details) && typeof details.status === "string") {
		return typeof details.shortId === "string"
			? `${details.shortId} \u00b7 ${details.status}`
			: undefined;
	}
	return undefined;
}

/** The task's first line; the frame truncates it to the terminal width. */
function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? text;
}

function formatBlockingOutcome(shortId: string, outcomes: readonly TaskWaitOutcome[]): string {
	const outcome = outcomes[0];
	if (outcome === undefined) return `${shortId}: no result`;
	if (outcome.status === "not_found") return `${shortId}: not found`;
	return `${shortId} ${outcome.status}\n${outcome.output}`;
}
