import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HePiRuntimeContext } from "@hheei/pi-basics";
import { buildSessionContext, buildTurnDelta, extractPrimaryTurnEvidence } from "./context.js";
import {
	collectFeedback,
	emptyFeedback,
	type FeedbackState,
	markFeedbackDelivered,
	reconfirmFeedback,
} from "./feedback.js";
import { type AdvisorPhase, type AdvisorStatus, DEFAULT_ADVISOR_USAGE } from "./model.js";
import { appendAdvisorBoundary, restoreAdvisor } from "./persistence.js";
import {
	type AdvisorAdapterOptions,
	type AdvisorAgentAdapter,
	createCoreAdvisorAdapter,
} from "./runtime.js";
export interface AdvisorFeature {
	start(
		runtime: HePiRuntimeContext,
		config?: { readonly model?: string; readonly thinking?: import("./model.js").ThinkingLevel },
	): Promise<void>;
	dispose(sessionId: string): Promise<void>;
	command(args: string, ctx: ExtensionCommandContext): Promise<void>;
	configure(model: string | undefined, thinking: import("./model.js").ThinkingLevel): Promise<void>;
	status(): AdvisorStatus;
}
interface Active {
	readonly sessionId: string;
	readonly runtime: HePiRuntimeContext;
	readonly adapter: AdvisorAgentAdapter;
	enabled: boolean;
	phase: AdvisorPhase;
	epoch: number;
	backlog: number;
	feedback: FeedbackState;
	reconfirming: boolean;
	terminalPending: boolean;
	pendingAdvisoryPrompt: string;
	primaryAborted: boolean;
	lastError?: string;
	model: string | undefined;
	thinking: import("./model.js").ThinkingLevel;
}
export type AdvisorAdapterFactory = (options: AdvisorAdapterOptions) => AdvisorAgentAdapter;

function isAbortedAssistantMessage(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	if (!("role" in message) || message.role !== "assistant") return false;
	return "stopReason" in message && message.stopReason === "aborted";
}

export function createAdvisorFeature(
	createAdapter: AdvisorAdapterFactory = createCoreAdvisorAdapter,
): AdvisorFeature {
	let active: Active | undefined;
	let queue: Promise<void> = Promise.resolve();
	const current = (ctx: { sessionManager: { getSessionId(): string } }): Active | undefined =>
		active?.sessionId === ctx.sessionManager.getSessionId() ? active : undefined;
	const isCurrent = (
		item: Active,
		epoch?: number,
		ctx?: { sessionManager: { getSessionId(): string } },
	): boolean =>
		active === item &&
		(ctx === undefined || item.sessionId === ctx.sessionManager.getSessionId()) &&
		(epoch === undefined || item.epoch === epoch);
	const enqueue = (operation: () => Promise<void>): Promise<void> => {
		const next = queue.then(operation, operation);
		queue = next.catch(() => undefined);
		return next;
	};
	const errorMessage = (error: unknown): string =>
		error instanceof Error ? error.message : String(error);
	const status = (): AdvisorStatus => {
		const item = active;
		return {
			enabled: item?.enabled ?? false,
			phase: item?.phase ?? "disabled",
			thinking: item?.thinking ?? "medium",
			...(item?.model === undefined ? {} : { model: item.model }),
			backlog: item?.backlog ?? 0,
			usage: item?.adapter.usage() ?? DEFAULT_ADVISOR_USAGE,
			...(item?.lastError === undefined ? {} : { lastError: item.lastError }),
		};
	};
	const deliver = (
		item: Active,
		notes: readonly import("./model.js").AdvisorAdvice[],
		triggerTurn: boolean,
	): void => {
		const content = notes.map((note) => `[${note.severity}] ${note.note}`).join("\n");
		if (triggerTurn) item.pendingAdvisoryPrompt = content;
		item.runtime.pi.sendMessage(
			{
				customType: "pi-basics-advisory",
				content,
				details: { notes },
				display: true,
			},
			{ deliverAs: "steer", triggerTurn },
		);
	};
	const scheduleReconfirm = (item: Active): void => {
		if (
			!isCurrent(item) ||
			!item.enabled ||
			!item.terminalPending ||
			item.reconfirming ||
			item.backlog > 0
		)
			return;
		if (item.feedback.held.length === 0) {
			item.terminalPending = false;
			return;
		}
		item.reconfirming = true;
		const epoch = item.epoch;
		void enqueue(async () => {
			try {
				if (!isCurrent(item, epoch) || !item.enabled) return;
				const raised = await item.adapter.review(
					`Reconfirm only these unresolved Advisor notes. Re-raise a note with advise only if it still applies; otherwise stay silent.\n${item.feedback.held.map((note) => `[${note.severity}] ${note.note}`).join("\n")}`,
				);
				if (!isCurrent(item, epoch) || !item.enabled) return;
				item.feedback = reconfirmFeedback(item.feedback, raised);
				const confirmed = item.feedback.deliverable.filter((note) => note.severity !== "nit");
				if (confirmed.length > 0) {
					deliver(item, confirmed, !item.primaryAborted);
					item.feedback = markFeedbackDelivered(item.feedback, confirmed);
				} else {
					item.feedback = { ...item.feedback, deliverable: [] };
				}
			} catch (error) {
				if (isCurrent(item, epoch)) item.lastError = errorMessage(error);
			} finally {
				if (isCurrent(item, epoch)) {
					item.reconfirming = false;
					item.terminalPending = false;
				}
			}
		});
	};
	const review = (item: Active, prompt: string): void => {
		const epoch = item.epoch;
		item.backlog++;
		item.phase = "reviewing";
		void enqueue(async () => {
			try {
				if (!isCurrent(item, epoch) || !item.enabled) return;
				const advice = await item.adapter.review(prompt);
				if (!isCurrent(item, epoch) || !item.enabled) return;
				item.feedback = collectFeedback(item.feedback, advice);
				const notes = item.feedback.deliverable;
				if (notes.length > 0) {
					deliver(item, notes, false);
					item.feedback = markFeedbackDelivered(item.feedback, notes);
				}
			} catch (error) {
				if (isCurrent(item, epoch)) item.lastError = errorMessage(error);
			} finally {
				if (isCurrent(item, epoch)) {
					item.backlog = Math.max(0, item.backlog - 1);
					if (item.enabled && item.backlog === 0) item.phase = "idle";
					else if (item.enabled) item.phase = "reviewing";
					if (item.backlog === 0) scheduleReconfirm(item);
				}
			}
		});
	};
	const reset = (item: Active): Promise<void> => {
		if (!isCurrent(item)) return Promise.resolve();
		const epoch = ++item.epoch;
		item.feedback = emptyFeedback();
		item.reconfirming = false;
		item.terminalPending = false;
		item.pendingAdvisoryPrompt = "";
		item.backlog = 0;
		item.phase = item.enabled ? "idle" : "disabled";
		if (!item.enabled) return Promise.resolve();
		return enqueue(async () => {
			if (!isCurrent(item) || !item.enabled) return;
			try {
				await item.adapter.reset();
			} catch (error) {
				if (isCurrent(item, epoch) && item.enabled) {
					item.lastError = errorMessage(error);
					item.phase = "error";
				}
			}
		});
	};
	return {
		status,
		async configure(model, thinking) {
			if (!active) return;
			const item = active;
			try {
				await enqueue(async () => {
					if (isCurrent(item)) await item.adapter.reconfigure(model, thinking);
				});
				if (active !== item) return;
				item.model = model;
				item.thinking = thinking;
				delete item.lastError;
			} catch (error) {
				if (active === item) item.lastError = errorMessage(error);
				throw error;
			}
		},

		async start(runtime, config) {
			if (active?.sessionId === runtime.ctx.sessionManager.getSessionId()) return;
			const adapter = createAdapter({
				ctx: runtime.ctx,
				model: config?.model,
				thinking: config?.thinking ?? "medium",
			});
			const restored = restoreAdvisor(runtime.ctx.sessionManager.getBranch(), (message) =>
				runtime.ctx.ui.notify(message, "warning"),
			);
			const item: Active = {
				sessionId: runtime.ctx.sessionManager.getSessionId(),
				runtime,
				adapter,
				enabled: restored.enabled,
				phase: restored.enabled ? "starting" : "disabled",
				epoch: 0,
				backlog: 0,
				feedback: emptyFeedback(),
				reconfirming: false,
				terminalPending: false,
				pendingAdvisoryPrompt: "",
				primaryAborted: false,
				model: config?.model,
				thinking: config?.thinking ?? "medium",
			};
			active = item;
			let currentUserPrompt = "";
			runtime.pi.on("before_agent_start", (event, eventCtx) => {
				if (!isCurrent(item, undefined, eventCtx)) return;
				const eventPrompt =
					typeof event === "object" && event !== null && "prompt" in event
						? event.prompt
						: undefined;
				const prompt = typeof eventPrompt === "string" ? eventPrompt : "";
				currentUserPrompt = prompt.length > 0 ? prompt : item.pendingAdvisoryPrompt;
				item.pendingAdvisoryPrompt = "";
			});
			runtime.pi.on("turn_end", (event, eventCtx) => {
				if (!isCurrent(item, undefined, eventCtx)) return;
				item.primaryAborted = isAbortedAssistantMessage(event.message);
				if (!item.enabled) return;
				const evidence = extractPrimaryTurnEvidence({
					message: event.message,
					toolResults: Array.isArray(event.toolResults) ? event.toolResults : [],
				});
				try {
					if (evidence.assistant !== undefined || evidence.tools.length > 0)
						review(
							item,
							buildSessionContext(
								buildTurnDelta(
									currentUserPrompt,
									evidence.assistant,
									evidence.tools,
									item.adapter.contextBudget(),
								),
							),
						);
				} catch (error) {
					item.lastError = errorMessage(error);
				}
				currentUserPrompt = "";
			});
			runtime.pi.on("agent_settled", (_event, eventCtx) => {
				if (!isCurrent(item, undefined, eventCtx) || !item.enabled) return;
				item.terminalPending = true;
				scheduleReconfirm(item);
			});
			runtime.pi.on("session_compact", (_event, eventCtx) => {
				if (!isCurrent(item, undefined, eventCtx)) return;
				return reset(item);
			});
			runtime.pi.on("session_tree", (_event, eventCtx) => {
				if (!isCurrent(item, undefined, eventCtx)) return;
				const restoredBranch = restoreAdvisor(
					item.runtime.ctx.sessionManager.getBranch(),
					(message) => item.runtime.ctx.ui.notify(message, "warning"),
				);
				const wasEnabled = item.enabled;
				const epoch = ++item.epoch;
				item.enabled = restoredBranch.enabled;
				item.phase = restoredBranch.enabled ? "starting" : "disabled";
				if (!restoredBranch.enabled) item.runtime.ctx.ui.setStatus("advisor", undefined);
				item.feedback = emptyFeedback();
				item.reconfirming = false;
				item.terminalPending = false;
				item.pendingAdvisoryPrompt = "";
				item.backlog = 0;
				return enqueue(async () => {
					if (!isCurrent(item, epoch)) return;
					try {
						if (!restoredBranch.enabled) {
							await item.adapter.abort();
							await item.adapter.dispose();
						} else if (wasEnabled) await item.adapter.reset();
						else await item.adapter.create();
						if (!isCurrent(item, epoch)) return;
						item.phase = restoredBranch.enabled ? "idle" : "disabled";
						item.runtime.ctx.ui.setStatus(
							"advisor",
							restoredBranch.enabled ? "Advisor" : undefined,
						);
						delete item.lastError;
					} catch (error) {
						if (!isCurrent(item, epoch)) return;
						item.enabled = false;
						item.phase = "error";
						item.runtime.ctx.ui.setStatus("advisor", undefined);
						item.lastError = errorMessage(error);
						await item.adapter.dispose().catch(() => undefined);
					}
				});
			});
			if (restored.enabled) {
				try {
					await adapter.create();
					if (!isCurrent(item)) {
						await adapter.dispose().catch(() => undefined);
						return;
					}
					item.phase = "idle";
					runtime.ctx.ui.setStatus("advisor", "Advisor");
				} catch (error) {
					if (!isCurrent(item)) {
						await adapter.dispose().catch(() => undefined);
						return;
					}
					item.enabled = false;
					item.phase = "disabled";
					runtime.ctx.ui.setStatus("advisor", undefined);
					item.lastError = errorMessage(error);
					await adapter.dispose().catch(() => undefined);
				}
			}
		},
		async dispose(sessionId) {
			if (!active || active.sessionId !== sessionId) return;
			const item = active;
			active = undefined;
			item.epoch++;
			item.enabled = false;
			item.phase = "disabled";
			item.feedback = emptyFeedback();
			item.reconfirming = false;
			item.terminalPending = false;
			item.pendingAdvisoryPrompt = "";
			item.backlog = 0;
			item.runtime.ctx.ui.setStatus("advisor", undefined);
			await item.adapter.abort();
			await item.adapter.dispose();
		},
		async command(args, ctx) {
			const item = current(ctx);
			if (!item) {
				ctx.ui.notify("Advisor runtime is not active", "error");
				return;
			}
			const action = args || "status";
			if (action === "status") {
				const value = status();
				ctx.ui.notify(
					[
						`Advisor ${value.enabled ? "on" : "off"}`,
						`phase=${value.phase}`,
						`model=${value.model ?? "not configured"}`,
						`thinking=${value.thinking}`,
						`backlog=${value.backlog}`,
						`tokens=${value.usage.total}`,
						`cost=${value.usage.cost}`,
						...(value.lastError === undefined ? [] : [`error=${value.lastError}`]),
					].join("; "),
					"info",
				);
				return;
			}
			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /advisor [on|off|status]", "error");
				return;
			}
			if (action === "on") {
				if (!item.enabled) {
					const epoch = item.epoch;
					try {
						await item.adapter.create();
						if (!isCurrent(item, epoch)) {
							await item.adapter.dispose().catch(() => undefined);
							return;
						}
						appendAdvisorBoundary(item.runtime.pi, { version: 1, enabled: true });
					} catch (error) {
						await item.adapter.dispose().catch(() => undefined);
						if (!isCurrent(item, epoch)) return;
						item.lastError = errorMessage(error);
						throw error;
					}
					item.enabled = true;
					item.phase = "idle";
					item.runtime.ctx.ui.setStatus("advisor", "Advisor");
				}
			} else if (item.enabled) {
				appendAdvisorBoundary(item.runtime.pi, { version: 1, enabled: false });
				item.epoch++;
				item.enabled = false;
				item.phase = "disabled";
				item.runtime.ctx.ui.setStatus("advisor", undefined);
				item.feedback = emptyFeedback();
				item.reconfirming = false;
				item.terminalPending = false;
				item.pendingAdvisoryPrompt = "";
				item.backlog = 0;
				await item.adapter.abort();
				await item.adapter.dispose();
			}
			ctx.ui.notify(`※ Advisor ${action}`, "info");
		},
	};
}
