/**
 * Child-side completion reminder.
 *
 * Adapted from HazAT/maplezzk pi-interactive-subagents `subagent-done.ts`
 * (MIT, upstream 7a5c96be138158a5cf6413ac819509eff12b1ccd). This version
 * reminds the child to call `contact_parent` and never exits the session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord } from "@hheei/pi-ext-core";

const ASSISTANT_ROLE = "assistant";
const NORMAL_STOP_REASON = "stop";
const DEFAULT_NUDGE_DELAY_MS = 5_000;
const MIN_NUDGE_DELAY_MS = 1_000;

const NUDGE_TEXT =
	"You finished a turn without calling contact_parent. If the parent needs a progress update, important finding, decision, or blocker, call contact_parent now. Do not wait for the parent to poll you.";

/** Return true only when the latest assistant message ended by the model stopping normally. */
export function shouldScheduleAgentEndNudge(
	messages: readonly { role?: string; stopReason?: string }[] | undefined,
): boolean {
	if (messages === undefined || messages.length === 0) return false;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== ASSISTANT_ROLE) continue;
		return message.stopReason === NORMAL_STOP_REASON;
	}
	return false;
}

function parseNudgeDelayMs(rawValue: string | undefined): number {
	const parsed = Number.parseInt(rawValue ?? "", 10);
	if (!Number.isFinite(parsed)) return DEFAULT_NUDGE_DELAY_MS;
	return Math.max(MIN_NUDGE_DELAY_MS, parsed);
}

function agentEndMessages(
	event: unknown,
): readonly { role?: string; stopReason?: string }[] | undefined {
	if (!isRecord(event) || !Array.isArray(event.messages)) return undefined;
	const messages: { role?: string; stopReason?: string }[] = [];
	for (const item of event.messages) {
		if (!isRecord(item)) continue;
		messages.push({
			...(typeof item.role === "string" ? { role: item.role } : {}),
			...(typeof item.stopReason === "string" ? { stopReason: item.stopReason } : {}),
		});
	}
	return messages;
}

export interface ChildNudgeController {
	markReported(): void;
	listen(pi: ExtensionAPI): void;
	dispose(): void;
}

/** Owns the delay timer and the “already reported / user took over” gates. */
export function createChildNudgeController(
	options: { readonly delayMs?: number; readonly disabled?: boolean } = {},
): ChildNudgeController {
	const delayMs = options.delayMs ?? parseNudgeDelayMs(process.env.PI_SUBAGENTS_NUDGE_DELAY_MS);
	const disabled = options.disabled ?? process.env.PI_SUBAGENTS_NUDGE_DISABLE === "1";
	let reported = false;
	let userInputAfterAgentEnd = false;
	let agentStarted = false;
	let userTookOver = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopListening: (() => void) | undefined;
	const clearTimer = (): void => {
		if (timer === null) return;
		clearTimeout(timer);
		timer = null;
	};

	return {
		markReported(): void {
			reported = true;
			clearTimer();
		},
		listen(pi): void {
			const registered = [
				pi.on("input", () => {
					userInputAfterAgentEnd = true;
					clearTimer();
					if (agentStarted) userTookOver = true;
				}),
				pi.on("before_agent_start", () => {
					clearTimer();
				}),
				pi.on("agent_start", () => {
					agentStarted = true;
					reported = false;
					userInputAfterAgentEnd = false;
					clearTimer();
				}),
				pi.on("agent_end", (event) => {
					if (disabled || reported || userTookOver) {
						clearTimer();
						return;
					}
					if (!shouldScheduleAgentEndNudge(agentEndMessages(event))) {
						clearTimer();
						return;
					}
					clearTimer();
					timer = setTimeout(() => {
						timer = null;
						if (reported || userInputAfterAgentEnd || userTookOver) return;
						pi.sendUserMessage(NUDGE_TEXT, { deliverAs: "followUp" });
					}, delayMs);
				}),
			];
			stopListening = () => {
				for (const off of registered) off();
			};
		},
		dispose(): void {
			clearTimer();
			// Reminders belong to the bound session: a child that left it must not nudge whatever session
			// the process is serving next.
			stopListening?.();
			stopListening = undefined;
		},
	};
}

export function registerChildNudge(pi: ExtensionAPI): ChildNudgeController {
	const controller = createChildNudgeController();
	controller.listen(pi);
	return controller;
}
