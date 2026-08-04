import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MCTX_CACHE_TTL_MS = 5 * 60 * 1000;

export interface MctxTokenBreakdown {
	readonly systemPrompt: number;
	readonly docs: number;
	readonly compartments: number;
	readonly memories: number;
	readonly profile: number;
	readonly conversation: number;
	readonly toolCalls: number;
	readonly toolDefinitions: number;
}

export function emptyMctxStatusAccounting(): MctxStatusAccounting {
	return {
		cacheTtlMs: DEFAULT_MCTX_CACHE_TTL_MS,
		lastResponseAtMs: 0,
		work: { newWorkTokens: 0, totalInputTokens: 0 },
		tokens: emptyMctxTokenBreakdown(),
	};
}

export interface MctxStatusAccounting {
	readonly cacheTtlMs: number;
	readonly lastResponseAtMs: number;
	readonly work: MctxWorkMetrics;
	readonly tokens: MctxTokenBreakdown;
}

export interface MctxWorkMetrics {
	readonly newWorkTokens: number;
	readonly totalInputTokens: number;
}

export interface MctxToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown;
}

export function emptyMctxTokenBreakdown(): MctxTokenBreakdown {
	return {
		systemPrompt: 0,
		docs: 0,
		compartments: 0,
		memories: 0,
		profile: 0,
		conversation: 0,
		toolCalls: 0,
		toolDefinitions: 0,
	};
}

function estimatePiMessage(message: AgentMessage): number {
	try {
		return Math.max(0, estimateTokens(message as never));
	} catch {
		return 0;
	}
}

function estimateText(text: string): number {
	if (text.length === 0) return 0;
	return estimatePiMessage({ role: "user", content: text, timestamp: 0 });
}

function estimateAssistantBlock(block: unknown): number {
	if (!isRecord(block) || typeof block.type !== "string") return 0;
	if (block.type === "image") return 1200;
	return estimatePiMessage({ role: "assistant", content: [block] } as never);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

function addBreakdown(
	breakdown: MctxTokenBreakdown,
	field: keyof MctxTokenBreakdown,
	value: number,
): MctxTokenBreakdown {
	return { ...breakdown, [field]: breakdown[field] + value };
}

/** Counts the same model-visible message categories used by the upstream panel. */
export function computeMctxTokenBreakdown(
	messages: readonly AgentMessage[],
	options: { readonly systemPrompt?: string } = {},
): MctxTokenBreakdown {
	let breakdown = emptyMctxTokenBreakdown();
	if (options.systemPrompt !== undefined)
		breakdown = addBreakdown(breakdown, "systemPrompt", estimateText(options.systemPrompt));

	for (const message of messages) {
		if (message.role === "custom") {
			const customType =
				"customType" in message && typeof message.customType === "string" ? message.customType : "";
			const field =
				customType === "pi-mctx:m0" || customType === "pi-mctx:m1"
					? "compartments"
					: customType.includes("memory")
						? "memories"
						: customType.includes("profile")
							? "profile"
							: customType.includes("docs")
								? "docs"
								: "conversation";
			breakdown = addBreakdown(breakdown, field, estimatePiMessage(message));
			continue;
		}
		if (message.role === "toolResult") {
			breakdown = addBreakdown(breakdown, "toolCalls", estimatePiMessage(message));
			continue;
		}
		if (message.role !== "assistant") {
			breakdown = addBreakdown(breakdown, "conversation", estimatePiMessage(message));
			continue;
		}
		for (const block of message.content) {
			if (isRecord(block) && block.type === "toolCall")
				breakdown = addBreakdown(breakdown, "toolCalls", estimateAssistantBlock(block));
			else breakdown = addBreakdown(breakdown, "conversation", estimateAssistantBlock(block));
		}
	}
	return breakdown;
}

export function computeMctxToolDefinitionTokens(tools: readonly MctxToolDefinition[]): number {
	let total = 0;
	for (const tool of tools) {
		const serialized = `${tool.name}\n${tool.description}\n${safeStringify(tool.parameters)}`;
		total += estimateText(serialized);
	}
	return total;
}

interface AssistantUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function assistantUsage(entry: SessionEntry): AssistantUsage | undefined {
	if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant")
		return undefined;
	const usage = entry.message.usage;
	if (!isRecord(usage)) return undefined;
	return {
		input: finiteNumber(usage.input),
		output: finiteNumber(usage.output),
		cacheRead: finiteNumber(usage.cacheRead ?? usage.cache_read),
		cacheWrite: finiteNumber(usage.cacheWrite ?? usage.cache_write),
	};
}

/** Mirrors upstream Pi work accounting, including prompt-reset phases. */
export function computeMctxWorkMetrics(entries: readonly SessionEntry[]): MctxWorkMetrics {
	let previousPrompt = 0;
	let phasePeak = 0;
	let newWorkTokens = 0;
	let totalInputTokens = 0;
	let lastOutput = 0;
	let sawAssistant = false;
	for (const entry of entries) {
		const usage = assistantUsage(entry);
		if (usage === undefined) continue;
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		if (sawAssistant && prompt < previousPrompt) {
			totalInputTokens += phasePeak;
			phasePeak = prompt;
		} else {
			phasePeak = Math.max(phasePeak, prompt);
		}
		newWorkTokens += Math.max(0, prompt - previousPrompt);
		previousPrompt = prompt;
		lastOutput = usage.output;
		sawAssistant = true;
	}
	if (sawAssistant) {
		totalInputTokens += phasePeak;
		newWorkTokens += lastOutput;
	}
	return {
		newWorkTokens: Math.max(0, Math.floor(newWorkTokens)),
		totalInputTokens: Math.max(0, Math.floor(totalInputTokens)),
	};
}

function safeStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "" : serialized;
	} catch {
		return "";
	}
}
