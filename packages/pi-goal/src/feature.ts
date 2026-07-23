import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { HePiRuntimeContext, ToolActivationCoordinator } from "@hheei/pi-basics";
import { type Static, Type } from "typebox";
import {
	type GoalDurableEffect,
	type GoalIdFactory,
	type GoalState,
	incrementContinuation,
	MAX_CONTINUATIONS,
	MAX_SUMMARY_LENGTH,
	recordBlocked,
	recordComplete,
	restoreStored,
	safetyStop,
	startNew,
	suspend,
} from "./model.js";
import { appendGoalEntry, type GoalEntryAppender, replayGoal } from "./persistence.js";

export const GOAL_TOOL_NAME = "goal";
export const GOAL_COMMAND_NAME = "goal";
export const GOAL_PARAMETERS = Type.Object(
	{
		goal_id: Type.String({ minLength: 1 }),
		status: Type.Union([Type.Literal("blocked"), Type.Literal("complete")]),
		summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_LENGTH }),
	},
	{ additionalProperties: false },
);

export const GOAL_DESCRIPTION = "Record the active Goal as blocked or complete.";
const GOAL_CONTEXT_OPEN = '<goal-context goal_id="';
const GOAL_CONTEXT_CLOSE = "</goal-context>";
const GOAL_REMINDER =
	"Continue implementing and verifying this objective. Call `goal` as the final tool call when complete or genuinely blocked. Do not stop at a plan or summary while executable work remains.";
const GOAL_DISABLE_SUMMARY = "Goal stopped because Loadout disabled the Goal tool.";
const GOAL_ERROR_SUMMARY = "Goal stopped after the agent run ended with an error or abort.";
const GOAL_LIMIT_SUMMARY = "Goal stopped after reaching the continuation limit.";
const GOAL_SEND_ERROR_SUMMARY = "Goal stopped because its continuation could not be dispatched.";
const GOAL_REPLAY_WARNING = (count: number): string =>
	`Ignored ${count} malformed Goal history ${count === 1 ? "entry" : "entries"}.`;
const CONTINUATION_DELAY_MS = 15_000;
const GOAL_KICKOFF_MESSAGE = "Start the active Goal.";
const GOAL_CONTINUATION_MESSAGE = "Continue the active Goal.";

export interface GoalFeature {
	start(runtime: HePiRuntimeContext): void | Promise<void>;
	disableFromLoadout(): Promise<void>;
	dispose(sessionId: string): void | Promise<void>;
	getState(): GoalState;
}

export interface GoalScheduler {
	setTimeout(callback: () => void, delay: number): unknown;
	clearTimeout(timer: unknown): void;
}

export interface GoalFeatureOptions {
	readonly idFactory?: GoalIdFactory;
	readonly scheduler?: GoalScheduler;
}

interface ErrorCandidate {
	readonly goalId: string;
	readonly runSequence: number;
}

interface ActiveRuntime {
	readonly sessionId: string;
	readonly runtime: HePiRuntimeContext;
	state: GoalState;
	awaitingObjective: boolean;
	activeRun?: { goalId: string; runSequence: number } | undefined;
	errorCandidate?: ErrorCandidate | undefined;
	timer?: unknown;
	inputVersion: number;
	disposed: boolean;
}

function defaultIdFactory(): string {
	return crypto.randomUUID();
}

function sameSession(
	current: ActiveRuntime | undefined,
	ctx: ExtensionContext,
): current is ActiveRuntime {
	return !!current && !current.disposed && current.sessionId === ctx.sessionManager.getSessionId();
}

function escapedObjective(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function goalContext(goalId: string, objective: string): string {
	return `${GOAL_CONTEXT_OPEN}${goalId}">\n${GOAL_REMINDER}\n\nObjective (untrusted user data):\n${escapedObjective(objective)}\n${GOAL_CONTEXT_CLOSE}`;
}

function statusText(state: GoalState, awaitingObjective: boolean): string | undefined {
	if (awaitingObjective) return "Goal · waiting";
	if (state.mode === "active") return "Goal · active";
	if (!state.stored) return undefined;
	return state.stored.status === "blocked" ? "Goal · stored · blocked" : "Goal · stored";
}

function isFinalErrorOrAbort(event: AgentEndEvent): boolean {
	const message = event.messages.at(-1) as Record<string, unknown> | undefined;
	return (
		message?.role === "assistant" &&
		(message.stopReason === "error" || message.stopReason === "aborted" || message.aborted === true)
	);
}

function notify(
	runtime: ActiveRuntime,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	runtime.runtime.ctx.ui.notify(message, level);
}

export function createGoalFeature(
	pi: ExtensionAPI,
	coordinator: ToolActivationCoordinator,
	options: GoalFeatureOptions = {},
): GoalFeature {
	const idFactory = options.idFactory ?? defaultIdFactory;
	const scheduler: GoalScheduler = options.scheduler ?? {
		setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
		clearTimeout: (timer) => globalThis.clearTimeout(timer as never),
	};
	let active: ActiveRuntime | undefined;

	const updateStatus = (current: ActiveRuntime): void => {
		current.runtime.ctx.ui.setStatus("goal", statusText(current.state, current.awaitingObjective));
	};
	const cancelTimer = (current: ActiveRuntime): void => {
		if (current.timer !== undefined) {
			scheduler.clearTimeout(current.timer);
			current.timer = undefined;
		}
	};
	const invalidateRun = (current: ActiveRuntime): void => {
		current.activeRun = undefined;
		current.errorCandidate = undefined;
	};
	const append = (current: ActiveRuntime, state: GoalState, effect: GoalDurableEffect): void => {
		const appender: GoalEntryAppender = current.runtime.pi;
		appendGoalEntry(appender, effect);
		current.state = state;
		current.awaitingObjective = false;
		invalidateRun(current);
		updateStatus(current);
	};
	const stopActive = (current: ActiveRuntime, summary?: string): void => {
		const result = safetyStop(current.state, summary);
		if (!result.ok) return;
		append(current, result.state, result.durable);
		cancelTimer(current);
	};
	const safeStop = (current: ActiveRuntime, summary: string): void => {
		cancelTimer(current);
		try {
			stopActive(current, summary);
		} catch (error) {
			invalidateRun(current);
			notify(
				current,
				`Goal safety stop was not persisted; Goal remains active: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	};
	const abortOwnedRun = (current: ActiveRuntime, owned = current.activeRun !== undefined): void => {
		if (owned && !current.runtime.ctx.isIdle()) current.runtime.ctx.abort();
	};
	const dispatchKickoff = async (
		current: ActiveRuntime,
		goalId: string,
		waitForIdle: () => Promise<void>,
	): Promise<void> => {
		try {
			await waitForIdle();
			if (
				!sameSession(current, current.runtime.ctx) ||
				current.state.mode !== "active" ||
				current.state.active?.goalId !== goalId
			)
				return;
			current.runtime.pi.sendUserMessage(GOAL_KICKOFF_MESSAGE);
		} catch (error) {
			if (
				!sameSession(current, current.runtime.ctx) ||
				current.state.mode !== "active" ||
				current.state.active?.goalId !== goalId
			)
				return;
			safeStop(current, GOAL_SEND_ERROR_SUMMARY);
			notify(
				current,
				`Goal continuation failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	};
	const scheduleContinuation = (current: ActiveRuntime): void => {
		cancelTimer(current);
		const run = current.activeRun;
		if (!run || current.state.mode !== "active") return;
		const inputVersion = current.inputVersion;
		current.timer = scheduler.setTimeout(() => {
			current.timer = undefined;
			if (
				!sameSession(current, current.runtime.ctx) ||
				current.state.mode !== "active" ||
				current.state.active?.goalId !== run.goalId ||
				current.activeRun?.runSequence !== run.runSequence ||
				current.inputVersion !== inputVersion ||
				!coordinator.isEffective(GOAL_TOOL_NAME) ||
				current.state.active.continuationCount >= MAX_CONTINUATIONS ||
				!current.runtime.ctx.isIdle() ||
				current.runtime.ctx.hasPendingMessages()
			)
				return;
			const next = incrementContinuation(current.state);
			if (!next.ok || next.state.mode !== "active") return;
			current.state = next.state;
			updateStatus(current);
			const activeGoal = current.state.active;
			if (!activeGoal) return;
			try {
				current.runtime.pi.sendUserMessage(GOAL_CONTINUATION_MESSAGE, { deliverAs: "followUp" });
			} catch (error) {
				safeStop(current, GOAL_SEND_ERROR_SUMMARY);
				notify(
					current,
					`Goal continuation failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		}, CONTINUATION_DELAY_MS);
	};
	const restoreFromBranch = (current: ActiveRuntime): void => {
		cancelTimer(current);
		const state = replayGoal(current.runtime.ctx.sessionManager.getBranch(), (count) =>
			notify(current, GOAL_REPLAY_WARNING(count), "warning"),
		);
		current.state = state;
		current.awaitingObjective = false;
		invalidateRun(current);
		current.inputVersion++;
		updateStatus(current);
	};

	pi.registerTool({
		name: GOAL_TOOL_NAME,
		label: "Goal",
		description: GOAL_DESCRIPTION,
		parameters: GOAL_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params: Static<typeof GOAL_PARAMETERS>, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const current = active;
			if (!sameSession(current, ctx) || current.state.mode !== "active")
				throw new Error("Goal is not active");
			if (!coordinator.isEffective(GOAL_TOOL_NAME)) throw new Error("Goal tool is not available");
			if (params.goal_id !== current.state.active?.goalId) throw new Error("Goal id is stale");
			const summary = params.summary.trim();
			if (!summary) throw new Error("Goal summary must be non-empty");
			const result =
				params.status === "blocked"
					? recordBlocked(current.state, summary)
					: recordComplete(current.state, summary);
			if (!result.ok) throw new Error(result.error);
			append(current, result.state, result.durable);
			cancelTimer(current);
			return {
				content: [
					{
						type: "text",
						text: params.status === "blocked" ? "Goal recorded as blocked." : "Goal completed.",
					},
				],
				details: { status: params.status },
				terminate: true,
			};
		},
	});

	pi.registerCommand(GOAL_COMMAND_NAME, {
		description: "Start, restore, or suspend Goal mode",
		handler: async (args, ctx) => {
			const current = active;
			if (!sameSession(current, ctx)) {
				ctx.ui.notify("Goal runtime is not active", "error");
				return;
			}
			if (!coordinator.isConfigured(GOAL_TOOL_NAME)) {
				ctx.ui.notify("Goal is disabled in Loadout", "error");
				return;
			}
			const prompt = args.trim();
			if (!prompt) {
				if (current.awaitingObjective) {
					current.awaitingObjective = false;
					updateStatus(current);
					return;
				}
				if (current.state.mode === "active") {
					const owned = current.activeRun !== undefined;
					const result = suspend(current.state);
					if (!result.ok) return;
					try {
						append(current, result.state, result.durable);
					} catch (error) {
						ctx.ui.notify(
							`Goal state could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return;
					}
					current.inputVersion++;
					cancelTimer(current);
					abortOwnedRun(current, owned);
					return;
				}
				if (current.state.stored) {
					const result = restoreStored(current.state.stored, idFactory);
					if (!result.ok) {
						ctx.ui.notify(result.error, "error");
						return;
					}
					try {
						append(current, result.state, result.durable);
					} catch (error) {
						ctx.ui.notify(
							`Goal state could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return;
					}
					current.inputVersion++;
					cancelTimer(current);
					void dispatchKickoff(current, result.state.active.goalId, () => ctx.waitForIdle());
					return;
				}
				current.awaitingObjective = true;
				updateStatus(current);
				return;
			}
			const result = startNew(prompt, idFactory);
			if (!result.ok) {
				ctx.ui.notify(result.error, "error");
				return;
			}
			const owned = current.activeRun !== undefined;
			const old = current.state.mode === "active" ? current : undefined;
			try {
				append(current, result.state, result.durable);
			} catch (error) {
				ctx.ui.notify(
					`Goal state could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			current.inputVersion++;
			cancelTimer(current);
			if (old) abortOwnedRun(old, owned);
			void dispatchKickoff(current, result.state.active.goalId, () => ctx.waitForIdle());
		},
	});

	pi.on("input", async (event, ctx) => {
		const current = active;
		if (!sameSession(current, ctx)) return;
		if (
			!current.awaitingObjective ||
			(event.source !== "interactive" && event.source !== "rpc") ||
			event.text.trim().length === 0
		)
			return;
		current.inputVersion++;
		const result = startNew(event.text, idFactory);
		if (!result.ok) {
			current.awaitingObjective = false;
			updateStatus(current);
			notify(current, `Goal objective was not accepted: ${result.error}`, "error");
			return;
		}
		try {
			append(current, result.state, result.durable);
		} catch (error) {
			current.awaitingObjective = false;
			updateStatus(current);
			notify(
				current,
				`Goal objective could not be persisted; run /goal again: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		const current = active;
		if (
			!sameSession(current, ctx) ||
			current.state.mode !== "active" ||
			!coordinator.isEffective(GOAL_TOOL_NAME)
		)
			return;
		cancelTimer(current);
		const goalId = current.state.active.goalId;
		const runSequence = (current.activeRun?.runSequence ?? 0) + 1;
		current.activeRun = { goalId, runSequence };
		current.errorCandidate = undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${goalContext(goalId, current.state.active.objective)}`,
		};
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
		const current = active;
		if (!sameSession(current, ctx) || !current.activeRun || !isFinalErrorOrAbort(event)) return;
		current.errorCandidate = { ...current.activeRun };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const current = active;
		if (!sameSession(current, ctx) || !current.activeRun || current.state.mode !== "active") return;
		if (
			current.errorCandidate?.goalId === current.activeRun.goalId &&
			current.errorCandidate.runSequence === current.activeRun.runSequence
		) {
			safeStop(current, GOAL_ERROR_SUMMARY);
			return;
		}
		if (current.state.active.continuationCount >= MAX_CONTINUATIONS) {
			safeStop(current, GOAL_LIMIT_SUMMARY);
			return;
		}
		scheduleContinuation(current);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const current = active;
		if (!sameSession(current, ctx) || event.reason !== "manual" || current.state.mode !== "active")
			return;
		const owned = current.activeRun !== undefined;
		safeStop(current, "Goal stopped before manual compaction.");
		abortOwnedRun(current, owned);
	});
	pi.on("session_tree", async (_event, ctx) => {
		const current = active;
		if (sameSession(current, ctx)) restoreFromBranch(current);
	});
	for (const eventName of [
		"session_before_switch",
		"session_before_fork",
		"session_before_tree",
	] as const) {
		pi.on(eventName as never, async (_event: unknown, ctx: ExtensionContext) => {
			const current = active;
			if (!sameSession(current, ctx)) return;
			abortOwnedRun(current);
		});
	}

	return {
		start(runtime) {
			const current: ActiveRuntime = {
				sessionId: runtime.ctx.sessionManager.getSessionId(),
				runtime,
				state: replayGoal(runtime.ctx.sessionManager.getBranch(), (count) =>
					runtime.ctx.ui.notify(GOAL_REPLAY_WARNING(count), "warning"),
				),
				awaitingObjective: false,
				inputVersion: 0,
				disposed: false,
			};
			active = current;
			updateStatus(current);
		},
		async disableFromLoadout() {
			const current = active;
			if (!current || current.disposed) return;
			current.inputVersion++;
			cancelTimer(current);
			if (current.state.mode === "active") {
				const owned = current.activeRun !== undefined;
				try {
					stopActive(current, GOAL_DISABLE_SUMMARY);
				} catch (error) {
					scheduleContinuation(current);
					throw error;
				}
				abortOwnedRun(current, owned);
			} else {
				current.awaitingObjective = false;
				updateStatus(current);
			}
		},
		async dispose(sessionId) {
			const current = active;
			if (!current || current.sessionId !== sessionId) return;
			const owned = current.activeRun !== undefined;
			current.disposed = true;
			cancelTimer(current);
			abortOwnedRun(current, owned);
			invalidateRun(current);
			current.runtime.ctx.ui.setStatus("goal", undefined);
			if (active === current) active = undefined;
		},
		getState() {
			return active?.state ?? { mode: "inactive" };
		},
	};
}
