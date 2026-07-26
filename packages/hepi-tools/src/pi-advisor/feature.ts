import { createHash } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HePiRuntimeContext } from "../hepi-basics/index.js";
import {
	buildSessionContext,
	buildTurnDelta,
	contextInputCharBudget,
	extractPrimaryTurnEvidence,
} from "./context.js";
import {
	collectFeedback,
	emptyFeedback,
	type FeedbackState,
	markFeedbackDelivered,
	reconfirmFeedback,
} from "./feedback.js";
import {
	type AdvisorAdvice,
	type AdvisorPhase,
	type AdvisorStatus,
	DEFAULT_ADVISOR_USAGE,
	severityRank,
} from "./model.js";
import { appendAdvisorBoundary, restoreAdvisor } from "./persistence.js";
import {
	type AdvisorAdapterOptions,
	type AdvisorAgentAdapter,
	createCoreAdvisorAdapter,
} from "./runtime.js";

const REVIEW_INTERVAL_MS = 15_000;
const CONCERN_COOLDOWN_MS = 25_000;
const BLOCKER_COOLDOWN_MS = 40_000;

interface AdvisorThrottleOptions {
	readonly now?: () => number;
	readonly setTimeout?: (callback: () => void, delay: number) => unknown;
	readonly clearTimeout?: (timer: unknown) => void;
}

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
	adapterActive: boolean;
	enabled: boolean;
	phase: AdvisorPhase;
	epoch: number;
	backlog: number;
	feedback: FeedbackState;
	reconfirming: boolean;
	terminalPending: boolean;
	terminalGeneration: number;
	pendingAdvisoryPrompt: string;
	userPrompt: string;
	primaryAborted: boolean;
	lastReviewAt?: number | undefined;
	lastMaterialSignature?: string | undefined;
	reviewCooldownUntil: number;
	reviewCooldownTimer?: unknown;
	pendingReviewTimer?: unknown;
	pendingReviewPrompt: string;
	pendingReviewUserPromptGeneration: number;
	pendingMaterialEvidence: string[];
	notifiedHigh: Map<string, AdvisorAdvice["severity"]>;
	lastError?: string;
	model: string | undefined;
	thinking: import("./model.js").ThinkingLevel;
}
export type AdvisorAdapterFactory = (options: AdvisorAdapterOptions) => AdvisorAgentAdapter;

type AdvisorIndicator = "ok" | "concern" | "blocker";

function indicatorFor(notes: readonly AdvisorAdvice[]): AdvisorIndicator {
	if (notes.some((note) => note.severity === "blocker")) return "blocker";
	if (notes.some((note) => note.severity === "concern")) return "concern";
	return "ok";
}

function publishIndicator(item: Active, notes: readonly AdvisorAdvice[]): void {
	item.runtime.ctx.ui.setStatus("advisor", item.enabled ? indicatorFor(notes) : undefined);
}

function isAbortedAssistantMessage(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	if (!("role" in message) || message.role !== "assistant") return false;
	return "stopReason" in message && message.stopReason === "aborted";
}

export function createAdvisorFeature(
	createAdapter: AdvisorAdapterFactory = createCoreAdvisorAdapter,
	throttleOptions: AdvisorThrottleOptions = {},
): AdvisorFeature {
	const now = throttleOptions.now ?? Date.now;
	const setTimeout =
		throttleOptions.setTimeout ??
		((callback: () => void, delay: number) => globalThis.setTimeout(callback, delay));
	const clearTimeout =
		throttleOptions.clearTimeout ?? ((timer: unknown) => globalThis.clearTimeout(timer as never));
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
	const adviceKey = (note: AdvisorAdvice): string =>
		note.note.toLowerCase().replace(/\s+/g, " ").trim();
	const cooldownFor = (notes: readonly AdvisorAdvice[]): number =>
		notes.some((note) => note.severity === "blocker")
			? BLOCKER_COOLDOWN_MS
			: notes.some((note) => note.severity === "concern")
				? CONCERN_COOLDOWN_MS
				: REVIEW_INTERVAL_MS;
	const reviewAllowedAt = (item: Active): number =>
		item.lastReviewAt === undefined
			? item.reviewCooldownUntil
			: Math.max(item.reviewCooldownUntil, item.lastReviewAt + REVIEW_INTERVAL_MS);
	const materialSignature = (prompt: string, userPromptGeneration: number): string =>
		createHash("sha256").update(`${userPromptGeneration}\n${prompt}`).digest("hex");
	const fitPendingText = (value: string, chars: number): string => {
		const marker = "\n…[advisor pending evidence truncated]…\n";
		if (value.length <= chars) return value;
		if (chars <= marker.length) return marker.slice(0, Math.max(0, chars));
		const contentChars = chars - marker.length;
		const head = Math.ceil(contentChars / 2);
		return value.slice(0, head) + marker + value.slice(value.length - Math.floor(contentChars / 2));
	};
	const addPendingMaterial = (item: Active, prompt: string): void => {
		const toolsStart = prompt.indexOf("\n\nTOOLS:\n");
		if (toolsStart < 0) return;
		const material = prompt.slice(toolsStart + 2).trim();
		if (material.length === 0 || item.pendingMaterialEvidence.includes(material)) return;
		item.pendingMaterialEvidence.push(material);
		if (item.pendingMaterialEvidence.length > 4) item.pendingMaterialEvidence.shift();
	};
	const pendingPrompt = (item: Active): string => {
		const latest = item.pendingReviewPrompt;
		const material = item.pendingMaterialEvidence.filter((value) => !latest.includes(value));
		if (material.length === 0) return latest;
		const separator = "\n\nEarlier material evidence:\n";
		const materialText = material.join("\n\n");
		const maxChars = contextInputCharBudget(item.adapter.contextBudget());
		if (latest.length + separator.length + materialText.length <= maxChars)
			return `${latest}${separator}${materialText}`;
		const materialChars = Math.floor(maxChars * 0.3);
		return `${fitPendingText(latest, Math.max(0, maxChars - separator.length - materialChars))}${separator}${fitPendingText(materialText, materialChars)}`;
	};
	const clearReviewTimer = (item: Active): void => {
		if (item.reviewCooldownTimer !== undefined) clearTimeout(item.reviewCooldownTimer);
		if (item.pendingReviewTimer !== undefined) clearTimeout(item.pendingReviewTimer);
		item.reviewCooldownTimer = undefined;
		item.pendingReviewTimer = undefined;
	};
	const printHighValue = (item: Active, notes: readonly AdvisorAdvice[]): void => {
		for (const note of notes) {
			if (note.severity === "nit") continue;
			const key = adviceKey(note);
			const previous = item.notifiedHigh.get(key);
			if (previous !== undefined && severityRank(previous) >= severityRank(note.severity)) continue;
			item.notifiedHigh.set(key, note.severity);
			item.runtime.pi.sendMessage({
				customType: "pi-basics-advisory",
				content: `[${note.severity}] ${note.note}`,
				details: { notes: [note] },
				display: true,
			});
		}
	};

	const deliver = (
		item: Active,
		notes: readonly AdvisorAdvice[],
		triggerTurn: boolean,
		display = true,
	): void => {
		const content = [
			"Advisor feedback: verify against the current state before acting.",
			notes.map((note) => `[${note.severity}] ${note.note}`).join("\n"),
		].join("\n");
		if (triggerTurn) item.pendingAdvisoryPrompt = content;
		item.runtime.pi.sendMessage(
			{
				customType: "pi-basics-advisory",
				content,
				details: { notes },
				display,
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
			if (item.pendingReviewPrompt.length === 0) item.terminalPending = false;
			return;
		}
		const wait = reviewAllowedAt(item) - now();
		if (wait > 0) {
			if (item.reviewCooldownTimer === undefined) {
				item.reviewCooldownTimer = setTimeout(() => {
					item.reviewCooldownTimer = undefined;
					scheduleReconfirm(item);
				}, wait);
			}
			return;
		}
		item.reconfirming = true;
		const epoch = item.epoch;
		const terminalGeneration = item.terminalGeneration;
		void enqueue(async () => {
			try {
				if (!isCurrent(item, epoch) || !item.enabled) return;
				item.lastReviewAt = now();
				const raised = await item.adapter.review(
					`Reconfirm only these unresolved Advisor notes. Re-raise a note with advise only if it still applies; otherwise stay silent.\n${item.feedback.held.map((note) => `[${note.severity}] ${note.note}`).join("\n")}`,
				);
				if (!isCurrent(item, epoch) || !item.enabled) return;
				if (item.terminalGeneration !== terminalGeneration) return;
				printHighValue(item, raised);
				item.reviewCooldownUntil = Math.max(item.reviewCooldownUntil, now() + cooldownFor(raised));
				publishIndicator(item, raised);
				delete item.lastError;
				item.feedback = reconfirmFeedback(item.feedback, raised);
				const confirmed = item.feedback.deliverable.filter((note) => note.severity !== "nit");
				if (confirmed.length > 0) {
					deliver(item, confirmed, !item.primaryAborted, false);
					item.feedback = markFeedbackDelivered(item.feedback, confirmed);
				} else {
					item.feedback = { ...item.feedback, deliverable: [] };
				}
			} catch (error) {
				if (isCurrent(item, epoch)) {
					item.runtime.ctx.ui.setStatus("advisor", undefined);
					item.lastError = errorMessage(error);
				}
			} finally {
				if (isCurrent(item, epoch)) {
					item.reconfirming = false;
					if (item.terminalGeneration === terminalGeneration) item.terminalPending = false;
					schedulePendingReview(item);
					scheduleReconfirm(item);
				}
			}
		});
	};
	const review = (
		item: Active,
		prompt: string,
		signature: string | undefined,
		userPromptGeneration: number,
	): void => {
		const epoch = item.epoch;
		item.backlog++;
		item.phase = "reviewing";
		void enqueue(async () => {
			try {
				if (!isCurrent(item, epoch) || !item.enabled) return;
				item.lastReviewAt = now();
				const advice = await item.adapter.review(prompt);
				if (!isCurrent(item, epoch) || !item.enabled) return;
				if (signature !== undefined) item.lastMaterialSignature = signature;
				printHighValue(item, advice);
				item.reviewCooldownUntil = Math.max(item.reviewCooldownUntil, now() + cooldownFor(advice));
				publishIndicator(item, advice);
				delete item.lastError;
				item.feedback = collectFeedback(item.feedback, advice);
				const notes = item.feedback.deliverable;
				if (notes.length > 0) {
					deliver(item, notes, item.terminalPending && !item.primaryAborted);
					item.feedback = markFeedbackDelivered(item.feedback, notes);
				}
			} catch (error) {
				if (isCurrent(item, epoch)) {
					if (item.pendingReviewPrompt.length === 0) {
						item.pendingReviewPrompt = prompt;
						item.pendingReviewUserPromptGeneration = userPromptGeneration;
					} else {
						addPendingMaterial(item, prompt);
					}
					item.runtime.ctx.ui.setStatus("advisor", undefined);
					item.lastError = errorMessage(error);
				}
			} finally {
				if (isCurrent(item, epoch)) {
					item.backlog = Math.max(0, item.backlog - 1);
					if (item.enabled && item.backlog === 0) item.phase = "idle";
					else if (item.enabled) item.phase = "reviewing";
					if (item.backlog === 0) {
						schedulePendingReview(item);
						scheduleReconfirm(item);
					}
				}
			}
		});
	};
	function schedulePendingReview(item: Active): void {
		if (
			!isCurrent(item) ||
			!item.enabled ||
			item.reconfirming ||
			item.backlog > 0 ||
			item.pendingReviewPrompt.length === 0
		)
			return;
		const prompt = pendingPrompt(item);
		const signature = materialSignature(prompt, item.pendingReviewUserPromptGeneration);
		if (item.lastMaterialSignature === signature) {
			item.pendingReviewPrompt = "";
			item.pendingMaterialEvidence = [];
			return;
		}
		const wait = reviewAllowedAt(item) - now();
		if (wait > 0) {
			if (item.pendingReviewTimer === undefined) {
				item.pendingReviewTimer = setTimeout(() => {
					item.pendingReviewTimer = undefined;
					schedulePendingReview(item);
				}, wait);
			}
			return;
		}
		item.pendingReviewPrompt = "";
		item.pendingMaterialEvidence = [];
		review(item, prompt, signature, item.pendingReviewUserPromptGeneration);
	}
	const requestReview = (item: Active, prompt: string, userPromptGeneration: number): void => {
		if (!isCurrent(item) || !item.enabled) return;
		if (item.pendingReviewPrompt.length > 0) addPendingMaterial(item, item.pendingReviewPrompt);
		item.pendingReviewPrompt = prompt;
		item.pendingReviewUserPromptGeneration = userPromptGeneration;
		schedulePendingReview(item);
	};
	const reset = (item: Active): Promise<void> => {
		if (!isCurrent(item)) return Promise.resolve();
		const epoch = ++item.epoch;
		item.feedback = emptyFeedback();
		item.reconfirming = false;
		item.terminalPending = false;
		item.terminalGeneration = 0;
		item.pendingAdvisoryPrompt = "";
		item.userPrompt = "";
		item.pendingReviewPrompt = "";
		item.pendingReviewUserPromptGeneration = 0;
		item.pendingMaterialEvidence = [];
		item.backlog = 0;
		clearReviewTimer(item);
		item.lastReviewAt = undefined;
		item.lastMaterialSignature = undefined;
		item.reviewCooldownUntil = 0;
		item.notifiedHigh.clear();
		item.phase = item.enabled ? "idle" : "disabled";
		item.runtime.ctx.ui.setStatus("advisor", undefined);
		if (!item.enabled) return Promise.resolve();
		return enqueue(async () => {
			if (!isCurrent(item) || !item.enabled) return;
			try {
				await item.adapter.reset();
				if (!isCurrent(item, epoch) || !item.enabled) return;
				publishIndicator(item, []);
				delete item.lastError;
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
				item.lastMaterialSignature = undefined;
				if (model === undefined || model.trim().length === 0) {
					if (item.enabled) appendAdvisorBoundary(item.runtime.pi, { version: 1, enabled: false });
					item.enabled = false;
					item.phase = "disabled";
					item.adapterActive = false;
					clearReviewTimer(item);
					item.pendingReviewPrompt = "";
					item.pendingReviewUserPromptGeneration = 0;
					item.pendingMaterialEvidence = [];
					item.userPrompt = "";
					item.lastReviewAt = undefined;
					item.lastMaterialSignature = undefined;
					item.reviewCooldownUntil = 0;
					item.notifiedHigh.clear();
					item.runtime.ctx.ui.setStatus("advisor", undefined);
				} else if (item.enabled) {
					publishIndicator(item, []);
				}
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
				adapterActive: false,
				enabled: restored.enabled,
				phase: restored.enabled ? "starting" : "disabled",
				epoch: 0,
				backlog: 0,
				feedback: emptyFeedback(),
				reconfirming: false,
				terminalPending: false,
				terminalGeneration: 0,
				pendingAdvisoryPrompt: "",
				userPrompt: "",
				pendingReviewPrompt: "",
				pendingReviewUserPromptGeneration: 0,
				pendingMaterialEvidence: [],
				primaryAborted: false,
				reviewCooldownUntil: 0,
				notifiedHigh: new Map(),
				model: config?.model,
				thinking: config?.thinking ?? "medium",
			};
			active = item;
			let userPromptGeneration = 0;
			runtime.pi.on("before_agent_start", (event, eventCtx) => {
				if (!isCurrent(item, undefined, eventCtx)) return;
				const eventPrompt =
					typeof event === "object" && event !== null && "prompt" in event
						? event.prompt
						: undefined;
				const prompt = typeof eventPrompt === "string" ? eventPrompt : "";
				if (prompt.length > 0) {
					item.userPrompt = prompt;
					userPromptGeneration++;
					item.pendingAdvisoryPrompt = "";
				}
			});
			runtime.pi.on("turn_end", (event, eventCtx) => {
				if (!isCurrent(item, undefined, eventCtx)) return;
				item.primaryAborted = isAbortedAssistantMessage(event.message);
				if (!item.enabled) return;
				const evidence = extractPrimaryTurnEvidence({
					message: event.message,
					toolResults: Array.isArray(event.toolResults) ? event.toolResults : [],
				});
				const reviewUserPrompt =
					item.pendingAdvisoryPrompt.length > 0 ? item.pendingAdvisoryPrompt : item.userPrompt;
				const reviewUserPromptGeneration = userPromptGeneration;
				item.pendingAdvisoryPrompt = "";
				try {
					if (evidence.assistant !== undefined || evidence.tools.length > 0)
						requestReview(
							item,
							buildSessionContext(
								buildTurnDelta(
									reviewUserPrompt,
									evidence.assistant,
									evidence.tools,
									item.adapter.contextBudget(),
								),
							),
							reviewUserPromptGeneration,
						);
				} catch (error) {
					item.lastError = errorMessage(error);
				}
				item.terminalGeneration++;
				if (item.feedback.held.length > 0) {
					item.terminalPending = true;
					scheduleReconfirm(item);
				}
			});
			runtime.pi.on("agent_settled", (_event, eventCtx) => {
				if (!isCurrent(item, undefined, eventCtx) || !item.enabled) return;
				item.terminalGeneration++;
				item.terminalPending = true;
				scheduleReconfirm(item);
			});
			runtime.pi.on("session_compact", (_event, eventCtx) => {
				if (!isCurrent(item, undefined, eventCtx)) return;
				userPromptGeneration = 0;
				item.userPrompt = "";
				return reset(item);
			});
			runtime.pi.on("session_tree", (_event, eventCtx) => {
				if (!isCurrent(item, undefined, eventCtx)) return;
				const restoredBranch = restoreAdvisor(
					item.runtime.ctx.sessionManager.getBranch(),
					(message) => item.runtime.ctx.ui.notify(message, "warning"),
				);
				const epoch = ++item.epoch;
				userPromptGeneration = 0;
				item.userPrompt = "";
				item.enabled = restoredBranch.enabled;
				item.phase = restoredBranch.enabled ? "starting" : "disabled";
				publishIndicator(item, []);
				item.feedback = emptyFeedback();
				item.reconfirming = false;
				item.terminalPending = false;
				item.terminalGeneration = 0;
				item.pendingAdvisoryPrompt = "";
				item.pendingReviewPrompt = "";
				item.pendingReviewUserPromptGeneration = 0;
				item.pendingMaterialEvidence = [];
				item.backlog = 0;
				clearReviewTimer(item);
				item.lastReviewAt = undefined;
				item.lastMaterialSignature = undefined;
				item.reviewCooldownUntil = 0;
				item.notifiedHigh.clear();
				return enqueue(async () => {
					if (!isCurrent(item, epoch)) return;
					try {
						if (!restoredBranch.enabled) {
							await item.adapter.abort();
							await item.adapter.dispose();
							item.adapterActive = false;
						} else if (item.adapterActive) {
							await item.adapter.reset();
						} else {
							await item.adapter.create();
							item.adapterActive = true;
						}
						if (!isCurrent(item, epoch)) return;
						item.phase = restoredBranch.enabled ? "idle" : "disabled";
						publishIndicator(item, []);
						delete item.lastError;
					} catch (error) {
						if (!isCurrent(item, epoch)) return;
						item.enabled = false;
						item.adapterActive = false;
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
					item.adapterActive = true;
					publishIndicator(item, []);
				} catch (error) {
					if (!isCurrent(item)) {
						await adapter.dispose().catch(() => undefined);
						return;
					}
					item.enabled = false;
					item.adapterActive = false;
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
			item.terminalGeneration = 0;
			item.pendingAdvisoryPrompt = "";
			item.pendingReviewPrompt = "";
			item.pendingReviewUserPromptGeneration = 0;
			item.pendingMaterialEvidence = [];
			item.userPrompt = "";
			item.backlog = 0;
			item.adapterActive = false;
			clearReviewTimer(item);
			item.lastReviewAt = undefined;
			item.reviewCooldownUntil = 0;
			item.notifiedHigh.clear();
			item.runtime.ctx.ui.setStatus("advisor", undefined);
			try {
				await item.adapter.abort();
			} finally {
				await item.adapter.dispose();
			}
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
				await enqueue(async () => {
					if (!isCurrent(item) || item.enabled) return;
					const epoch = item.epoch;
					try {
						await item.adapter.create();
						if (!isCurrent(item, epoch)) {
							await item.adapter.dispose().catch(() => undefined);
							item.adapterActive = false;
							return;
						}
						appendAdvisorBoundary(item.runtime.pi, { version: 1, enabled: true });
						item.adapterActive = true;
						item.enabled = true;
						item.phase = "idle";
						publishIndicator(item, []);
					} catch (error) {
						try {
							await item.adapter.dispose();
						} finally {
							item.adapterActive = false;
						}
						if (isCurrent(item, epoch)) item.lastError = errorMessage(error);
						throw error;
					}
				});
			} else {
				if (item.enabled) {
					const hadPendingReview = item.backlog > 0 || item.reconfirming;
					appendAdvisorBoundary(item.runtime.pi, { version: 1, enabled: false });
					item.epoch++;
					item.enabled = false;
					item.phase = "disabled";
					item.runtime.ctx.ui.setStatus("advisor", undefined);
					item.feedback = emptyFeedback();
					item.reconfirming = false;
					item.terminalPending = false;
					item.pendingAdvisoryPrompt = "";
					item.pendingReviewPrompt = "";
					item.pendingReviewUserPromptGeneration = 0;
					item.pendingMaterialEvidence = [];
					item.userPrompt = "";
					item.backlog = 0;
					clearReviewTimer(item);
					item.lastReviewAt = undefined;
					item.lastMaterialSignature = undefined;
					item.reviewCooldownUntil = 0;
					item.notifiedHigh.clear();
					const cleanup = enqueue(async () => {
						try {
							await item.adapter.abort();
						} finally {
							try {
								await item.adapter.dispose();
							} finally {
								item.adapterActive = false;
							}
						}
					});
					if (!hadPendingReview) await cleanup;
					else void cleanup.catch(() => undefined);
				}
			}
			ctx.ui.notify(`※ Advisor ${action}`, "info");
		},
	};
}
