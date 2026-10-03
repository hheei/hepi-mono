import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { isRecord } from "@hheei/pi-ext-core";

export const DEFAULT_CODEMODE_GUARD_THRESHOLD = 4;
export const CODEMODE_REMINDER_CUSTOM_TYPE = "tool-call-reminder";

export const DEFAULT_CODEMODE_BATCH_REMINDER = `<system-reminder>
Reminder: You have made 4 consecutive \`codemode\` calls that each executed only a single tool.
Agent turns are extremely expensive: please batch and execute multiple tool calls in a single \`codemode\` script (e.g. via Promise.all) instead of calling them one by one.
Whenever searching or inspecting files, call as many \`read\` and \`grep\` operations in parallel as possible to locate information much faster.
</system-reminder>`;

export function isGeminiModel(model: unknown): boolean {
	if (!isRecord(model)) return false;
	const id = typeof model.id === "string" ? model.id.toLowerCase() : "";
	const name = typeof model.name === "string" ? model.name.toLowerCase() : "";
	const provider = typeof model.provider === "string" ? model.provider.toLowerCase() : "";
	const api = typeof model.api === "string" ? model.api.toLowerCase() : "";

	if (id.includes("gemini") || name.includes("gemini")) return true;
	if (provider === "gemini" || api === "gemini") return true;
	if (
		(provider === "google" ||
			provider === "google-vertex" ||
			api === "google" ||
			api === "google-generative-ai" ||
			api === "google-vertex") &&
		!id.includes("gemma") &&
		!id.includes("deep-research")
	) {
		return true;
	}
	return false;
}

export interface CodemodeGuardOptions {
	readonly threshold?: number;
	readonly reminderText?: string;
	readonly sendMessage?: (message: unknown, options?: unknown) => void;
}

export interface CodemodeGuard {
	readonly getConsecutiveCount: () => number;
	readonly hasTriggeredInCurrentLoop: () => boolean;
	readonly reset: () => void;
	readonly resetLoop: () => void;
	readonly recordToolResult: (
		event: ToolResultEvent,
		model: unknown,
	) => ToolResultEventResult | undefined;
}

export function createCodemodeGuard(options: CodemodeGuardOptions = {}): CodemodeGuard {
	const threshold = options.threshold ?? DEFAULT_CODEMODE_GUARD_THRESHOLD;
	const reminderText = options.reminderText ?? DEFAULT_CODEMODE_BATCH_REMINDER;
	let consecutiveCount = 0;
	let triggeredInCurrentLoop = false;

	const reset = (): void => {
		consecutiveCount = 0;
		triggeredInCurrentLoop = false;
	};

	const resetLoop = (): void => {
		consecutiveCount = 0;
		triggeredInCurrentLoop = false;
	};

	return {
		getConsecutiveCount: () => consecutiveCount,
		hasTriggeredInCurrentLoop: () => triggeredInCurrentLoop,
		reset,
		resetLoop,
		recordToolResult: (event, model) => {
			if (!isGeminiModel(model)) {
				consecutiveCount = 0;
				return undefined;
			}

			// Only inspect top-level codemode invocations
			if (event.toolName !== "codemode" || event.parentToolCallId !== undefined) {
				return undefined;
			}

			const details = isRecord(event.details) ? event.details : undefined;
			const calls = Array.isArray(details?.calls) ? details.calls : [];
			const callCount = calls.length;

			if (callCount <= 1) {
				consecutiveCount++;
				if (consecutiveCount >= threshold && !triggeredInCurrentLoop) {
					triggeredInCurrentLoop = true;
					consecutiveCount = 0;

					options.sendMessage?.(
						{
							customType: CODEMODE_REMINDER_CUSTOM_TYPE,
							content: reminderText,
							display: true,
						},
						{ deliverAs: "steer" },
					);
				}
			} else {
				// Successfully batched 2 or more tool calls in codemode
				consecutiveCount = 0;
			}

			// Never append to tool result content; reminder is delivered as an injected message
			return undefined;
		},
	};
}
