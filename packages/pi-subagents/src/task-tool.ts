/**
 * The unified `task` entry point.
 *
 * `task` is a background-task producer, not a second subagent front end: its result lands in the
 * same registry, the same `wait_tasks` reads and the same notification window as a background
 * Bash command. It requires the shared task registry, which `@hheei/pi-ext-tools` provides, and
 * stays inactive with an explicit reason when that integration is not installed.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionLifecycleContext,
	errorMessage,
	registerManagedTool,
	setManagedToolsActive,
	TASK_REGISTRY_SERVICE_KEY,
	type TaskRegistry,
	type TaskWaitOutcome,
	type ToolTui,
	textToolResult,
	waitForService,
} from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import type { TaskChildContract } from "./domain.js";
import type { AgentTaskExecutor } from "./task-executor.js";
import { DEFAULT_TASK_SOFT_TURNS } from "./task-result.js";
import { checkOutputSchema } from "./task-schema.js";

export const TASK_TOOL_ID = "task";
const OWNER = "@hheei/pi-subagents";
const TASK_TOOL_REGISTRATION = { id: TASK_TOOL_ID, owner: OWNER } as const;

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
				"true waits for the result in this call; false or omitted starts a background task (default)",
		}),
	),
	outputSchema: Type.Optional(
		Type.Unknown({
			description: "JSON Schema the final result must validate against; omit for a text result",
		}),
	),
});

export type TaskToolParams = Static<typeof taskSchema>;

const DESCRIPTION =
	"Run one delegated task as a background agent execution. Returns a task id immediately unless blocking is true. Read the result with wait_tasks, or let the automatic notification bring it back. The child is dedicated to this task and is terminated once it submits a final result, so use spawn_subagent when you need a reusable conversation partner instead.";

const GUIDELINES = [
	"Omit blocking (or pass false) for work that may outlive this call; its result is added to the context when it finishes.",
	"Pass blocking: true only when the result is needed in this call; that path never also sends a background notification.",
	"Do not poll wait_tasks for a background task. The automatic notification starts your next turn.",
	"Set outputSchema when you need a machine-readable result instead of prose.",
];

const UNAVAILABLE =
	"The task integration is unavailable: this session has no shared background-task registry. Install @hheei/pi-ext-tools to enable it, or use spawn_subagent for conversation-style delegation.";

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
		async execute(_id, params, signal): Promise<ReturnType<typeof textToolResult>> {
			const integration = active;
			if (integration === undefined) throw new Error(unavailable);
			const contract = taskContract(params.outputSchema);
			let started: ReturnType<AgentTaskExecutor["start"]>;
			try {
				started = integration.executor.start({
					agent: params.agent,
					task: params.task,
					...(params.cwd === undefined ? {} : { cwd: params.cwd }),
					...(params.blocking === true ? { inlineResult: true } : {}),
					contract,
				});
			} catch (error) {
				throw new Error(`Task was not accepted: ${errorMessage(error)}`);
			}
			if (params.blocking !== true) {
				return textToolResult(
					`Started ${started.shortId} (${started.id}). Its result is added to the context after the notification window; read it earlier with wait_tasks ${started.id}.`,
					{ id: started.id, shortId: started.shortId, status: started.status },
				);
			}
			const outcomes = await integration.registry.wait([started.id], signal);
			return textToolResult(formatBlockingOutcome(started.shortId, outcomes), outcomes);
		},
	};
	registerManagedTool(pi, TASK_TOOL_REGISTRATION, tui.frame(tool, { headerLine: "truncate" }));
	setManagedToolsActive(context, [TASK_TOOL_REGISTRATION], false);
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

/** Validates the caller's schema before any process exists. */
function taskContract(schema: unknown): TaskChildContract {
	if (schema === undefined) return { softTurns: DEFAULT_TASK_SOFT_TURNS };
	const reason = checkOutputSchema(schema);
	if (reason !== undefined) throw new Error(`Unsupported outputSchema: ${reason}`);
	return { schema, softTurns: DEFAULT_TASK_SOFT_TURNS };
}

function formatBlockingOutcome(shortId: string, outcomes: readonly TaskWaitOutcome[]): string {
	const outcome = outcomes[0];
	if (outcome === undefined) return `${shortId}: no result`;
	if (outcome.status === "not_found") return `${shortId}: not found`;
	return `${shortId} ${outcome.status}\n${outcome.output}`;
}
