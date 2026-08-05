/** Stable Pi host system-prompt adjunct. It is never persisted in the transcript. */
export function buildMctxToolGuidance(protectedTags: number, cavemanEnabled: boolean): string {
	const cavemanWarning = cavemanEnabled
		? "\nHistory compression can rewrite old text into terse caveman style. That text is not the user's or assistant's original wording. Do not imitate it; write fresh normal prose."
		: "";
	return `## Magic Context

Messages and tool outputs use §N§ tags. Use ctx_reduce only for large, old tool outputs you already analyzed. Do not drop user, assistant, or reference text. The newest ${protectedTags} tags are protected. Mark a spent tool output immediately; it remains recoverable through ctx_expand until reclaimed. Select tags with "3-5", "1,2,9", or "1-5,8,12-15". Review each tag; never drop a blanket range.

Drop silently. Never narrate a drop. A [dropped §N§] marker means the original tool result is unavailable in context; make a real tool call when needed. Never simulate a dropped tool call, tool output, command result, search result, edit, or diff in text. ctx_history manages retained history from other sessions.${cavemanWarning}`;
}

export interface MctxNudgeBaseline {
	readonly usageTokens: number;
	readonly contextWindow: number;
	readonly executeThresholdPercentage: number;
	readonly reclaimableTags: readonly number[];
	turnToolTokens: number;
	lastLevel: 0 | 1 | 2;
	reduced: boolean;
}

export function estimateMctxToolTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

export function buildMctxToolReminder(tags: readonly number[], ceiling: boolean): string {
	const selector = tags.slice(0, 8).join(",");
	return `<system-reminder>Context pressure is rising. Review completed tool outputs and silently call ctx_reduce for obsolete tool tags${selector ? `: ${selector}` : ""}. Keep user and assistant text. ${ceiling ? "Reclaim now before continuing." : "Reclaim after this result if it is no longer needed."}</system-reminder>`;
}
