import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { HePiRuntimeContext } from "../hepi-basics/index.js";
import type { PlanConfirmationResult, PlanThinkingLevel } from "./confirmation.js";
import { createPlanConfirmationComponent } from "./confirmation.js";
import {
	buildPlanImplementationPrompt,
	buildPlanModePrompt,
	buildPlanRefinementPrompt,
	extractProposedPlan,
	type PlanPhase,
	planStatus,
	type RequestedPlanAction,
	stripProposedPlan,
} from "./model.js";
import {
	appendPlanBoundary,
	type PlanBoundary,
	planUrl,
	type RestoredPlan,
	restorePlan,
} from "./persistence.js";

const PLAN_COMMAND_NAME = "plan";

type PlanMessage = AgentEndEvent["messages"][number];
interface PlanMessageEndEvent {
	readonly message: PlanMessage;
}
interface PlanMessageEndResult {
	readonly message: PlanMessage;
}

interface PendingPlan {
	readonly plan: string;
	readonly wasPlanning: boolean;
	readonly shouldAsk: boolean;
}

interface ActivePlan {
	readonly sessionId: string;
	readonly runtime: HePiRuntimeContext;
	phase: PlanPhase;
	plan?: string | undefined;
	planEntryId?: string | undefined;
	planUrl?: string | undefined;
	requestedAction?: RequestedPlanAction | undefined;
	pendingPlan?: PendingPlan | undefined;
	initialAskPending: boolean;
	disposed: boolean;
}

export interface PlanFeature {
	start(runtime: HePiRuntimeContext): void;
	dispose(sessionId: string): void;
}

function sameSession(
	current: ActivePlan | undefined,
	ctx: ExtensionContext,
): current is ActivePlan {
	return !!current && !current.disposed && current.sessionId === ctx.sessionManager.getSessionId();
}

function boundary(current: ActivePlan): PlanBoundary {
	if (current.phase === "none")
		return {
			version: 1,
			phase: "none",
			...(current.planEntryId === undefined ? {} : { planEntryId: current.planEntryId }),
			...(current.planUrl === undefined ? {} : { planUrl: current.planUrl }),
			initialAskPending: current.initialAskPending,
		};
	return {
		version: 1,
		phase: current.phase,
		...(current.planEntryId === undefined ? {} : { planEntryId: current.planEntryId }),
		...(current.planUrl === undefined ? {} : { planUrl: current.planUrl }),
		...(current.requestedAction === undefined ? {} : { requestedAction: current.requestedAction }),
		initialAskPending: current.initialAskPending,
	};
}

function updateStatus(current: ActivePlan): void {
	current.runtime.ctx.ui.setStatus("plan", planStatus(current.phase));
}

function persist(current: ActivePlan): void {
	appendPlanBoundary(current.runtime.pi, boundary(current));
}

function restored(runtime: HePiRuntimeContext): RestoredPlan {
	return restorePlan(runtime.ctx.sessionManager.getBranch(), (warning) =>
		runtime.ctx.ui.notify(`Plan history ignored: ${warning}`, "warning"),
	);
}

export function createPlanFeature(pi: ExtensionAPI): PlanFeature {
	let active: ActivePlan | undefined;

	const beginRefinement = (current: ActivePlan): void => {
		if (!current.plan || !current.planUrl) return;
		current.requestedAction = undefined;
		current.phase = "plan-refine";
		persist(current);
		updateStatus(current);
		pi.sendUserMessage(buildPlanRefinementPrompt(current.planUrl, current.plan), {
			deliverAs: "followUp",
		});
	};

	const publishPendingPlan = async (ctx: ExtensionContext): Promise<void> => {
		const current = active;
		if (!sameSession(current, ctx)) return;
		const pending = current.pendingPlan;
		if (!pending) return;
		current.pendingPlan = undefined;
		const { plan, wasPlanning, shouldAsk } = pending;
		pi.sendMessage(
			{ customType: "pi-basics-plan", content: plan, display: true, details: { version: 1 } },
			{ triggerTurn: false },
		);
		const entry = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find(
				(candidate) =>
					candidate.type === "custom_message" && candidate.customType === "pi-basics-plan",
			);
		const url = entry ? planUrl(ctx, entry.id) : undefined;
		if (!entry || !url) {
			ctx.ui.notify("Plan was saved but no stable Plan URL is available.", "warning");
			return;
		}
		current.plan = plan;
		current.planEntryId = entry.id;
		current.planUrl = url;
		current.requestedAction = undefined;
		current.phase = wasPlanning ? "plan" : "plan-refine";
		current.initialAskPending = false;
		persist(current);
		updateStatus(current);
		if (!shouldAsk) return;
		if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
			ctx.ui.notify(
				"Use /plan implement [compact|new|continue], /plan edit, or /plan stop.",
				"info",
			);
			return;
		}
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("Plan confirmation unavailable: no active model.", "warning");
			return;
		}
		try {
			const result = await ctx.ui.custom<PlanConfirmationResult>((tui, theme, _keybindings, done) =>
				createPlanConfirmationComponent({
					plan,
					model,
					availableModels: ctx.modelRegistry
						.getAvailable()
						.filter((candidate) => ctx.modelRegistry.hasConfiguredAuth(candidate)),
					selectModel: (candidate) =>
						pi.setModel(candidate as Parameters<ExtensionAPI["setModel"]>[0]),
					getThinkingLevel: () => {
						const level = pi.getThinkingLevel();
						return (level === "max" ? "xhigh" : level) as PlanThinkingLevel;
					},
					setThinkingLevel: (level) =>
						pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]),
					host: { requestRender: () => tui.requestRender() },
					theme,
					done,
				}),
			);
			if (!sameSession(active, ctx) || active !== current || current.phase !== "plan") return;
			if (result?.status !== "selected") return;
			if (result.action === "refine") {
				beginRefinement(current);
				return;
			}
			await runAction(current, ctx as unknown as ExtensionCommandContext, result.action);
		} catch (error) {
			if (sameSession(active, ctx))
				ctx.ui.notify(
					`Unable to open Plan confirmation: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
		}
	};

	const leave = (current: ActivePlan, notify = true): void => {
		current.phase = "none";
		current.requestedAction = undefined;
		current.pendingPlan = undefined;
		persist(current);
		updateStatus(current);
		if (notify) current.runtime.ctx.ui.notify("※ Plan mode stopped", "info");
	};
	const restoreAfterFailure = (
		current: ActivePlan,
		ctx: ExtensionCommandContext,
		message: string,
	): void => {
		current.phase = "plan-refine";
		current.requestedAction = undefined;
		persist(current);
		updateStatus(current);
		ctx.ui.notify(message, "info");
	};

	const runAction = async (
		current: ActivePlan,
		ctx: ExtensionCommandContext,
		action: RequestedPlanAction,
	): Promise<void> => {
		if (!current.plan || !current.planUrl) {
			ctx.ui.notify("No plan is ready to implement.", "warning");
			return;
		}
		const prompt = buildPlanImplementationPrompt(current.planUrl, current.plan);
		leave(current, false);
		if (action === "new") {
			ctx.ui.notify("※ Implement plan in new section", "info");
			try {
				const parentSession = ctx.sessionManager.getSessionFile();
				const result = await ctx.newSession({
					...(parentSession === undefined ? {} : { parentSession }),
					withSession: async (replacement) => replacement.sendUserMessage(prompt),
				});
				if (!result.cancelled) return;
			} catch {
				restoreAfterFailure(
					current,
					ctx,
					"Plan implementation could not start. Plan remains available for refinement.",
				);
				return;
			}
			restoreAfterFailure(
				current,
				ctx,
				"Plan implementation was cancelled. Refine it with /plan edit.",
			);
			return;
		}
		if (action === "continue") {
			ctx.ui.notify("※ Implement plan in current session", "info");
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			return;
		}
		ctx.ui.notify("※ Implement plan after compact", "info");
		let settled = false;
		try {
			ctx.compact({
				customInstructions:
					"Preserve the active pi-basics plan and its implementation requirements.",
				onComplete: () => {
					if (settled) return;
					try {
						pi.sendUserMessage(prompt, { deliverAs: "followUp" });
						settled = true;
					} catch {
						settled = true;
						restoreAfterFailure(
							current,
							ctx,
							"Plan implementation could not start. Plan remains available for refinement.",
						);
					}
				},
				onError: () => {
					if (settled) return;
					settled = true;
					restoreAfterFailure(
						current,
						ctx,
						"Plan compaction failed. Plan remains available in session history.",
					);
				},
			});
		} catch {
			if (!settled) {
				settled = true;
				restoreAfterFailure(
					current,
					ctx,
					"Plan compaction failed. Plan remains available in session history.",
				);
			}
		}
	};

	const topLevelCompletions = (prefix: string): AutocompleteItem[] =>
		(["edit", "show", "stop", "implement"] as const)
			.filter((value) => value.startsWith(prefix.trim()))
			.map((value) => ({ value, label: value }));

	const implementationCompletions = (prefix: string): AutocompleteItem[] =>
		(["compact", "new", "continue"] as const)
			.filter((value) => value.startsWith(prefix.trim()))
			.map((value) => ({ value: `implement ${value}`, label: `implement ${value}` }));

	pi.registerCommand(PLAN_COMMAND_NAME, {
		description: "Enter, review, refine, or implement the current Plan Mode plan",
		getArgumentCompletions: (argumentPrefix) => {
			const match = argumentPrefix.match(/^implement(?:\s+([^\s]*))?$/);
			return match
				? implementationCompletions(match[1] ?? "")
				: topLevelCompletions(argumentPrefix);
		},
		handler: async (args, ctx) => {
			const current = active;
			if (!sameSession(current, ctx)) {
				ctx.ui.notify("Plan runtime is not active", "error");
				return;
			}
			const value = args.trim();
			if (value === "stop") {
				leave(current);
				return;
			}
			if (value === "show") {
				ctx.ui.notify(
					current.plan && current.planUrl
						? `${current.planUrl}\n\n${current.plan}`
						: "No completed plan is available.",
					"info",
				);
				return;
			}
			const implementation = value.match(/^implement(?:\s+(compact|new|continue))?$/);
			if (implementation) {
				await runAction(
					current,
					ctx,
					(implementation[1] as RequestedPlanAction | undefined) ?? "compact",
				);
				return;
			}
			if (value.startsWith("implement ")) {
				ctx.ui.notify("Usage: /plan implement [compact|new|continue]", "warning");
				return;
			}
			if (value === "edit") {
				if (current.phase === "none") {
					current.phase = "plan";
					current.initialAskPending = true;
					persist(current);
					updateStatus(current);
					pi.sendUserMessage(buildPlanModePrompt());
					return;
				}
				beginRefinement(current);
				return;
			}
			if (value) {
				if (current.phase === "none") {
					current.phase = "plan";
					current.initialAskPending = true;
				} else {
					current.phase = current.plan ? "plan-refine" : "plan";
					current.requestedAction = undefined;
				}
				persist(current);
				updateStatus(current);
				pi.sendUserMessage(value);
				return;
			}
			if (current.phase === "none") {
				current.phase = "plan";
				current.initialAskPending = true;
				persist(current);
				updateStatus(current);
				ctx.ui.notify("※ Plan mode enabled. Submit a prompt with /plan <prompt>.", "info");
				return;
			}
			if (current.phase === "plan" && !current.plan) {
				leave(current);
				return;
			}
			if (current.requestedAction) {
				const action = current.requestedAction;
				current.requestedAction = undefined;
				await runAction(current, ctx, action);
				return;
			}
			if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
				ctx.ui.notify(
					"Use /plan edit to refine, or select an implementation action in interactive mode.",
					"info",
				);
				return;
			}
			const choice = await ctx.ui.select("What should we do with this plan?", [
				"Implement (new)",
				"Implement (compact)",
				"Implement (continue)",
				"Exit",
			]);
			if (!choice) {
				current.phase = "plan-refine";
				persist(current);
				updateStatus(current);
				return;
			}
			if (choice === "Exit") {
				leave(current);
				return;
			}
			await runAction(
				current,
				ctx,
				choice === "Implement (new)"
					? "new"
					: choice === "Implement (continue)"
						? "continue"
						: "compact",
			);
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		const current = active;
		if (!sameSession(current, ctx) || (current.phase !== "plan" && current.phase !== "plan-refine"))
			return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt()}` };
	});
	const onMessageEnd = (
		event: PlanMessageEndEvent,
		ctx: ExtensionContext,
	): PlanMessageEndResult | undefined => {
		const current = active;
		if (
			!sameSession(current, ctx) ||
			(current.phase !== "plan" && current.phase !== "plan-refine") ||
			event.message.role !== "assistant" ||
			!Array.isArray(event.message.content)
		)
			return;
		const plan = extractProposedPlan(
			event.message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		);
		if (!plan) return;
		const wasPlanning = current.phase === "plan";
		current.pendingPlan = {
			plan,
			wasPlanning,
			shouldAsk: wasPlanning && current.initialAskPending,
		};
		let changed = false;
		const content: typeof event.message.content = [];
		for (const part of event.message.content) {
			if (part.type !== "text") {
				content.push(part);
				continue;
			}
			const stripped = stripProposedPlan(part.text);
			if (stripped === undefined) {
				content.push(part);
				continue;
			}
			changed = true;
			if (stripped) content.push({ ...part, text: stripped });
		}
		return changed ? { message: { ...event.message, content } } : undefined;
	};
	(
		pi.on as unknown as (
			event: "message_end",
			handler: (
				event: PlanMessageEndEvent,
				ctx: ExtensionContext,
			) => PlanMessageEndResult | undefined,
		) => void
	)("message_end", onMessageEnd);
	pi.on("agent_settled", (_event, ctx) => publishPendingPlan(ctx));
	pi.on("session_tree", (_event, ctx) => {
		const current = active;
		if (!sameSession(current, ctx)) return;
		const state = restored(current.runtime);
		current.phase = state.boundary.phase;
		current.plan = state.plan;
		current.planEntryId = state.boundary.phase === "none" ? undefined : state.boundary.planEntryId;
		current.planUrl = state.boundary.phase === "none" ? undefined : state.boundary.planUrl;
		current.requestedAction =
			state.boundary.phase === "none" ? undefined : state.boundary.requestedAction;
		current.pendingPlan = undefined;
		current.initialAskPending =
			state.boundary.phase === "none" ? false : state.boundary.initialAskPending;
		updateStatus(current);
	});

	return {
		start(runtime) {
			const state = restored(runtime);
			const current: ActivePlan = {
				sessionId: runtime.ctx.sessionManager.getSessionId(),
				runtime,
				phase: state.boundary.phase,
				plan: state.plan,
				...(state.boundary.phase === "none" ? {} : { planEntryId: state.boundary.planEntryId }),
				...(state.boundary.phase === "none" ? {} : { planUrl: state.boundary.planUrl }),
				...(state.boundary.phase === "none"
					? {}
					: { requestedAction: state.boundary.requestedAction }),
				initialAskPending:
					state.boundary.phase === "none" ? false : state.boundary.initialAskPending,
				disposed: false,
			};
			active = current;
			updateStatus(current);
		},
		dispose(sessionId) {
			if (!active || active.sessionId !== sessionId) return;
			active.disposed = true;
			active.runtime.ctx.ui.setStatus("plan", undefined);
			active = undefined;
		},
	};
}
