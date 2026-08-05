import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface MctxPressure {
	readonly inputTokens: number;
	readonly contextWindow: number;
}

const FORWARD_PRESSURE_LIMIT_FACTOR = 0.85;

/** Narrow provider-error classification; ordinary transport failures must not trigger drops. */
export function isMctxOverflow(errorMessage: unknown): boolean {
	return (
		typeof errorMessage === "string" &&
		/(?:context[_ -]?(?:length|window)|maximum context|token limit|too many tokens|prompt(?: is)? too long|input(?: is)? too long).*(?:exceed|too long|maximum|limit)|(?:exceed|too long).*(?:context|token)/iu.test(
			errorMessage,
		)
	);
}

function finiteUsage(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usagePressure(entry: SessionEntry): number | undefined {
	if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
	const usage = entry.message.usage;
	if (usage === undefined || typeof usage !== "object") return undefined;
	const value = usage as unknown as Readonly<Record<string, unknown>>;
	const input = finiteUsage(value.input);
	const cacheRead = finiteUsage(value.cacheRead ?? value.cache_read);
	const cacheWrite = finiteUsage(value.cacheWrite ?? value.cache_write);
	const total = input + cacheRead + cacheWrite;
	return total > 0 && Number.isSafeInteger(total) ? total : undefined;
}

function validWindow(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Latest assistant wire input wins; Pi's aggregate usage is only a cold-start fallback. */
export function resolveMctxPressure(
	context: ExtensionContext,
	detectedContextWindow: number | undefined,
): MctxPressure | undefined {
	const hostUsage = context.getContextUsage?.();
	const hostWindow = hostUsage?.contextWindow;
	const modelWindow = context.model?.contextWindow;
	const nominalWindow = validWindow(hostWindow)
		? hostWindow
		: validWindow(modelWindow)
			? modelWindow
			: undefined;
	const contextWindow =
		validWindow(detectedContextWindow) && nominalWindow !== undefined
			? Math.min(detectedContextWindow, nominalWindow)
			: validWindow(detectedContextWindow)
				? detectedContextWindow
				: nominalWindow;
	if (contextWindow === undefined) return undefined;
	const branch = context.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry === undefined) continue;
		const inputTokens = usagePressure(entry);
		if (inputTokens !== undefined) {
			const forwardTokens = validWindow(hostUsage?.tokens) ? hostUsage.tokens : 0;
			return {
				inputTokens:
					forwardTokens > inputTokens
						? Math.ceil(forwardTokens / FORWARD_PRESSURE_LIMIT_FACTOR)
						: inputTokens,
				contextWindow,
			};
		}
	}
	return validWindow(hostUsage?.tokens)
		? {
				inputTokens: Math.ceil(hostUsage.tokens / FORWARD_PRESSURE_LIMIT_FACTOR),
				contextWindow,
			}
		: undefined;
}

/** Provider errors sometimes disclose the actual accepted context window. */
export function detectMctxContextWindow(errorMessage: unknown): number | undefined {
	if (typeof errorMessage !== "string") return undefined;
	if (!isMctxOverflow(errorMessage)) return undefined;
	const values = errorMessage.matchAll(
		/(?:limit|window|maximum|max(?:imum)?\s+tokens?)\D{0,24}([\d,]{3,})/giu,
	);
	for (const value of values) {
		const parsed = Number((value[1] ?? "").replaceAll(",", ""));
		if (validWindow(parsed)) return parsed;
	}
	return undefined;
}
