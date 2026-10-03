import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { isRecord } from "@hheei/pi-ext-core";

export const DEFAULT_CODEMODE_GUARD_THRESHOLD = 4;

export const DEFAULT_CODEMODE_BATCH_REMINDER = `<system-reminder>
Reminder: You have made 4 consecutive \`codemode\` calls that each executed only a single tool.
Agent turns are extremely expensive: please batch and execute multiple tool calls in a single \`codemode\` script (e.g. via Promise.all) instead of calling them one by one.
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
		(provider === "google" || provider === "google-vertex" || api === "google") &&
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
}

export interface CodemodeGuard {
	readonly getConsecutiveCount: () => number;
	readonly reset: () => void;
	readonly recordToolResult: (
		event: ToolResultEvent,
		model: unknown,
	) => ToolResultEventResult | undefined;
}

export function createCodemodeGuard(options: CodemodeGuardOptions = {}): CodemodeGuard {
	const threshold = options.threshold ?? DEFAULT_CODEMODE_GUARD_THRESHOLD;
	const reminderText = options.reminderText ?? DEFAULT_CODEMODE_BATCH_REMINDER;
	let consecutiveCount = 0;

	return {
		getConsecutiveCount: () => consecutiveCount,
		reset: () => {
			consecutiveCount = 0;
		},
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
				if (consecutiveCount >= threshold) {
					consecutiveCount = 0; // reset after firing reminder
					const rawContent = [...event.content];
					const lastBlock = rawContent[rawContent.length - 1];

					if (lastBlock && lastBlock.type === "text") {
						rawContent[rawContent.length - 1] = {
							...lastBlock,
							text: `${lastBlock.text}\n\n${reminderText}`,
						};
					} else {
						rawContent.push({ type: "text", text: reminderText });
					}

					return { content: rawContent };
				}
			} else {
				// Successfully batched 2 or more tool calls in codemode
				consecutiveCount = 0;
			}

			return undefined;
		},
	};
}
