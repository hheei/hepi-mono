/**
 * Task-child result contract.
 *
 * A task child is launched for exactly one task. Its result reaches the parent through one
 * channel only: the `submit_task_result` tool validates the value against the caller's
 * `outputSchema`, records it, and returns Pi's native `terminate: true`. The ordinary
 * `contact_parent` channel carries progress and questions but never the final result, so the
 * parent does not have to guess which of two messages was the answer.
 */
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	errorMessage,
	getService,
	getToolTui,
	isRecord,
	registerToolTuiTrace,
	TASK_REGISTRY_SERVICE_KEY,
	textToolResult,
} from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { sendTaskResultToRunner } from "./connector.js";
import { type ChildIdentity, TASK_RESULT_TOOL_NAME, type TaskChildContract } from "./domain.js";
import { TASK_RESULT_EVENT } from "./protocol.js";
import { prepareStructuredResult, prepareTextResult } from "./task-schema.js";

export const TASK_ENVIRONMENT_KEY = "PI_SUBAGENTS_TASK";

/**
 * A task that has run this many turns is reminded once, and only once, to converge. It is a
 * prompt, not a limit: nothing is aborted, no model is switched, and the child may keep working.
 */
export const DEFAULT_TASK_SOFT_TURNS = 60;

export type { TaskChildContract } from "./domain.js";

const resultSchema = Type.Object(
	{
		result: Type.Optional(Type.Unknown()),
		note: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/** Encodes the contract for the child environment, or undefined for a conversation child. */
export function encodeTaskChildContract(contract: TaskChildContract): string {
	return JSON.stringify(contract);
}

/**
 * Decodes the contract the launch handed over. A malformed value is a configuration failure
 * rather than an absent contract: silently running without the requested schema would let an
 * unchecked result look valid.
 */
export function parseTaskChildContract(raw: string | undefined): TaskChildContract | undefined {
	if (raw === undefined || raw === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid ${TASK_ENVIRONMENT_KEY}: not JSON`, { cause: error });
	}
	if (!isRecord(parsed)) throw new Error(`Invalid ${TASK_ENVIRONMENT_KEY}: not an object`);
	const softTurns = parsed.softTurns;
	if (typeof softTurns !== "number" || !Number.isSafeInteger(softTurns) || softTurns < 1) {
		throw new Error(`Invalid ${TASK_ENVIRONMENT_KEY}: softTurns must be a positive integer`);
	}
	return { ...(parsed.schema === undefined ? {} : { schema: parsed.schema }), softTurns };
}

/** Reads the task contract from the child environment. */
export function taskContractFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): TaskChildContract | undefined {
	return parseTaskChildContract(env[TASK_ENVIRONMENT_KEY]);
}

/**
 * Background work this same session started. A result that precedes its own background work
 * would report a conclusion the child has not reached yet, so the submission is refused while
 * any of it is still running. Without the shared task registry there is no such work to see: the
 * background-capable bash belongs to the task extension, so a child that did not load it can only
 * run commands in the foreground.
 */
function outstandingBackgroundWork(pi: ExtensionAPI): number {
	return getService(pi, TASK_REGISTRY_SERVICE_KEY)?.activeCount ?? 0;
}

/**
 * One-shot convergence reminder. It fires at most once, never after a valid result exists, and
 * only as a message the child chooses how to act on: no abort, no model switch, no new limit.
 * Returns the disposer: the reminder belongs to the bound session, so a child that left it must not
 * count turns of whatever session the process serves next.
 */
export function registerTaskSoftHint(
	pi: ExtensionAPI,
	controller: TaskResultController,
	softTurns: number,
): () => void {
	let turns = 0;
	let reminded = false;
	return pi.on("turn_end", () => {
		turns += 1;
		if (reminded || turns < softTurns || controller.submission() !== undefined) return;
		reminded = true;
		pi.sendUserMessage(
			`You have completed ${softTurns} turns on this task. Nothing was stopped and you may keep working, but converge now: finish the verification you actually need, then submit the final answer with submit_task_result. If the task cannot be finished, report the blocker with contact_parent instead of waiting.`,
			{ deliverAs: "followUp" },
		);
	});
}

/** The candidate a task child may submit once. */
export interface TaskResultSubmission {
	readonly json: string;
	readonly structured: boolean;
}

export interface TaskResultController {
	/** The recorded candidate, if this execution already submitted a valid result. */
	submission(): TaskResultSubmission | undefined;
}

function messageToolCalls(message: unknown): number | undefined {
	if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
	return message.content.filter((part) => isRecord(part) && part.type === "toolCall").length;
}

/**
 * Counts the tool calls in the assistant message this tool call belongs to. Pi persists the
 * assistant message before running its tools, so the last assistant entry is the current one.
 */
function currentAssistantToolCalls(context: ExtensionContext): number | undefined {
	const branch = context.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry: unknown = branch[index];
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message) || message.role !== "assistant") continue;
		return messageToolCalls(message);
	}
	return undefined;
}

function submitFooter(result: AgentToolResult<unknown>): string | undefined {
	const details = result.details as { readonly bytes?: number } | undefined;
	return details?.bytes === undefined ? undefined : `${details.bytes} bytes`;
}

/**
 * Registers the task child's single final-result entry point. `getContract` is read at call
 * time so a reloaded session sees the same contract it was launched with.
 */
export function registerTaskResultTool(
	pi: ExtensionAPI,
	identity: ChildIdentity,
	options: {
		readonly contract: TaskChildContract;
		readonly isBound?: (sessionId: string) => boolean;
	},
): TaskResultController {
	registerToolTuiTrace(pi);
	const tui = getToolTui(pi);
	let recorded: TaskResultSubmission | undefined;

	const tool: ToolDefinition<typeof resultSchema> = {
		name: TASK_RESULT_TOOL_NAME,
		label: "Submit task result",
		description:
			"Submit the final result of this task. This is the only way the parent receives the result, and it must be the only tool call in this message. It is refused while the task's own background work is still running, and it cannot be sent twice.",
		promptSnippet:
			"Submit the final task result. Must be the only tool call in its message, after all background work has finished.",
		promptGuidelines: [
			"Do not report the final result through contact_parent; use contact_parent only for progress, findings, questions, or blockers.",
			"Call submit_task_result only when the result is complete and it is the only tool call in the message.",
			"Do not submit while background commands or child tasks you started are still running.",
		],
		parameters: resultSchema,
		async execute(_id, params, signal, _onUpdate, context) {
			const sessionId = context.sessionManager.getSessionId();
			if (options.isBound !== undefined && !options.isBound(sessionId)) {
				throw new Error(
					"This Pi session is not the bound subagent session; submit_task_result is disabled.",
				);
			}
			if (params.result === undefined) throw new Error("submit_task_result requires a result");
			if (recorded !== undefined) {
				throw new Error(
					`This task already submitted a result (${recorded.json.length} bytes); it cannot be replaced.`,
				);
			}
			const calls = currentAssistantToolCalls(context);
			if (calls !== undefined && calls > 1) {
				throw new Error(
					"submit_task_result must be the only tool call in its message; submit the result alone.",
				);
			}
			const outstanding = outstandingBackgroundWork(pi);
			if (outstanding > 0) {
				throw new Error(
					`This session still has ${outstanding} background task(s) running. Wait for them, or stop them with stop_tasks, before submitting the final result.`,
				);
			}
			const prepared =
				options.contract.schema === undefined
					? prepareTextResult(
							typeof params.result === "string" ? params.result : JSON.stringify(params.result),
						)
					: prepareStructuredResult(options.contract.schema, params.result);
			if (!prepared.ok) throw new Error(prepared.reason);
			recorded = {
				json: prepared.candidate.json,
				structured: options.contract.schema !== undefined,
			};
			const details = {
				type: TASK_RESULT_EVENT,
				parentSessionId: identity.parentSessionId,
				childId: identity.subagentId,
				runtimeIdentity: identity.runtimeIdentity,
				json: recorded.json,
				structured: recorded.structured,
			};
			try {
				await sendTaskResultToRunner(identity, details, signal);
			} catch (error) {
				// No result reached the parent, so the child must stay alive and be able to retry.
				recorded = undefined;
				throw new Error(`Failed to deliver the task result: ${errorMessage(error)}`, {
					cause: error,
				});
			}
			return {
				...textToolResult(
					`Result submitted to the parent (${recorded.json.length} bytes). This run is complete.`,
					{ ...details, bytes: recorded.json.length },
				),
				terminate: true,
			};
		},
	};
	pi.registerTool(
		tui.frame(tool, {
			summary: (args) => (args.note === undefined ? "final result" : args.note),
			headerLine: "truncate",
			footer: submitFooter,
		}),
	);
	return { submission: () => recorded };
}
