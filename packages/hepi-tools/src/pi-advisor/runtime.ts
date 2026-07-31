import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	createReadOnlyTools,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedChildSessionFactory } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { type ContextBudget, contextInputCharBudget } from "./context.js";
import { parseAdvice } from "./feedback.js";
import {
	ADVISOR_TOOL_NAMES,
	type AdvisorAdvice,
	type AdvisorUsage,
	DEFAULT_ADVISOR_USAGE,
	type ThinkingLevel,
} from "./model.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";

const ADVISOR_REVIEW_TIMEOUT_MS = 30_000;
const ADVISOR_COMPACT_THRESHOLD = 0.8;
const ADVISOR_SESSION_PREFIX = "pi-basics-advisor:";
const ADVISOR_RESPONSE_CAP = 4096;

export function advisorSessionId(primarySessionId: string): string {
	return `${ADVISOR_SESSION_PREFIX}${primarySessionId}`;
}

const ADVISE_PARAMETERS = Type.Object({
	severity: Type.Union([Type.Literal("nit"), Type.Literal("concern"), Type.Literal("blocker")]),
	note: Type.String({ minLength: 1, maxLength: 4000 }),
});

export interface AdvisorAgentAdapter {
	readonly activeTools: readonly string[];
	create(): Promise<void>;
	reset(): Promise<void>;
	review(prompt: string, signal?: AbortSignal): Promise<readonly AdvisorAdvice[]>;
	compact(): Promise<void>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	usage(): AdvisorUsage;
	contextBudget(): ContextBudget;
}

interface SessionContextSource {
	buildSessionContext(): { readonly messages: Parameters<typeof convertToLlm>[0] };
}
function hasResolvedContext(value: unknown): value is SessionContextSource {
	return (
		typeof value === "object" &&
		value !== null &&
		"buildSessionContext" in value &&
		typeof value.buildSessionContext === "function"
	);
}
interface AdvisorScheduler {
	readonly setTimeout: (callback: () => void, delay: number) => unknown;
	readonly clearTimeout: (timer: unknown) => void;
}

function createHostScheduler(): AdvisorScheduler {
	return {
		setTimeout: (callback, delay) => {
			const handle = globalThis.setTimeout(callback, delay);
			return () => globalThis.clearTimeout(handle);
		},
		clearTimeout: (timer) => {
			if (typeof timer === "function") timer();
		},
	};
}

export interface AdvisorAdapterOptions {
	readonly ctx: ExtensionContext;
	readonly model: string | undefined;
	readonly thinking: ThinkingLevel;
	/** Test-only child-session injection; production retains legacy Agent construction. */
	readonly testSessionFactory?: ResolvedChildSessionFactory;
	/** Test-only timer injection; production uses the host timers. */
	readonly scheduler?: AdvisorScheduler;
}

function resolveModel(options: AdvisorAdapterOptions) {
	const configuredModel = options.model?.trim();
	if (configuredModel === undefined || configuredModel.length === 0)
		throw new Error("Configure an Advisor model in /ext-settings");
	const ref = configuredModel.split("/", 2);
	if (ref[0] === undefined || ref[1] === undefined || ref[0].length === 0 || ref[1].length === 0)
		throw new Error(`Unavailable Advisor model: ${configuredModel}`);
	const model = options.ctx.modelRegistry.find(ref[0], ref[1]);
	if (model === undefined) throw new Error(`Unavailable Advisor model: ${configuredModel}`);
	if (model.provider !== ref[0] || model.id !== ref[1])
		throw new Error(`Unavailable Advisor model: ${configuredModel}`);
	if (!options.ctx.modelRegistry.hasConfiguredAuth(model))
		throw new Error(`Advisor model has no configured auth: ${model.provider}/${model.id}`);
	return model;
}

function resolveThinking(
	options: AdvisorAdapterOptions,
	model: ReturnType<typeof resolveModel>,
): ThinkingLevel {
	if (!model.reasoning) return "off";
	if (options.thinking === "off") return "off";
	const supported = getSupportedThinkingLevels(model);
	if (!supported.includes(options.thinking))
		throw new Error(`Unsupported Advisor thinking level: ${options.thinking}`);
	return options.thinking;
}

function usageFromMessage(message: AgentMessage): AdvisorUsage {
	if (typeof message !== "object" || message === null || !("usage" in message))
		return DEFAULT_ADVISOR_USAGE;
	const usage = message.usage;
	if (typeof usage !== "object" || usage === null) return DEFAULT_ADVISOR_USAGE;
	const numberAt = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	const input = numberAt("input" in usage ? usage.input : undefined);
	const output = numberAt("output" in usage ? usage.output : undefined);
	const total = numberAt("totalTokens" in usage ? usage.totalTokens : undefined);
	const costValue = "cost" in usage ? usage.cost : undefined;
	const cost =
		typeof costValue === "object" && costValue !== null && "total" in costValue
			? numberAt(costValue.total)
			: 0;
	return { input, output, total, cost };
}

function addUsage(left: AdvisorUsage, right: AdvisorUsage): AdvisorUsage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		total: left.total + right.total,
		cost: left.cost + right.cost,
	};
}

function isAdvisorMessage(message: AgentMessage): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		"customType" in message &&
		message.customType === "pi-basics-advisory"
	);
}

function finalAssistantStopReason(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") return message.stopReason;
	}
	return undefined;
}

function isLengthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /(?:maximum|limit|too\s+many)\s+(?:input\s+)?tokens?|(?:input|prompt|context)\s+(?:is\s+)?too\s+long|context\s+window|token\s+limit/i.test(
		message,
	);
}

function toolCallIds(message: AgentMessage): ReadonlySet<string> {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return new Set();
	return new Set(
		message.content.flatMap((part) =>
			typeof part === "object" &&
			part !== null &&
			part.type === "toolCall" &&
			typeof part.id === "string"
				? [part.id]
				: [],
		),
	);
}

function modelContextBudget(model: ReturnType<typeof resolveModel>): ContextBudget {
	return {
		contextWindow: model.contextWindow,
		responseReserve: Math.min(model.maxTokens, ADVISOR_RESPONSE_CAP),
	};
}

function trimIncompleteAssistant(
	message: AgentMessage,
	completed: ReadonlySet<string>,
): AgentMessage | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	const content = message.content.filter((part) => {
		if (typeof part !== "object" || part === null) return true;
		if (part.type === "thinking") return false;
		return part.type !== "toolCall" || (typeof part.id === "string" && completed.has(part.id));
	});
	if (content.length === 0) return undefined;
	if (content.length === message.content.length) return message;
	return { ...message, content };
}

function fitBootstrapMessages(
	messages: readonly AgentMessage[],
	budget: ContextBudget,
): readonly AgentMessage[] {
	const units: AgentMessage[][] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message === undefined) continue;
		const ids = toolCallIds(message);
		const unit = [message];
		while (ids.size > 0) {
			const next = messages[index + 1];
			if (next === undefined || next.role !== "toolResult" || !ids.has(next.toolCallId)) break;
			unit.push(next);
			index += 1;
		}
		units.push(unit);
	}
	const maxChars = contextInputCharBudget(budget);
	const selected: AgentMessage[][] = [];
	let chars = 0;
	for (let index = units.length - 1; index >= 0; index -= 1) {
		const unit = units[index];
		if (unit === undefined) continue;
		const unitChars = JSON.stringify(unit).length;
		if (chars + unitChars > maxChars) break;
		selected.unshift(unit);
		chars += unitChars;
	}
	if (selected.length === units.length) return selected.flat();
	if (selected.length === 0 && units.length > 0)
		throw new Error("Advisor bootstrap context cannot fit the configured model");
	const marker: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "[advisor bootstrap context truncated]" }],
		timestamp: Date.now(),
	};
	const markerChars = JSON.stringify(marker).length;
	while (selected.length > 0 && chars + markerChars > maxChars) {
		const removed = selected.shift();
		if (removed !== undefined) chars -= JSON.stringify(removed).length;
	}
	if (chars + markerChars > maxChars)
		throw new Error("Advisor bootstrap context cannot fit the configured model");
	return [marker, ...selected.flat()];
}

function stripToolResultDetails(message: AgentMessage): AgentMessage {
	if (message.role !== "toolResult") return message;
	if (message.details === undefined && message.addedToolNames === undefined) return message;
	return {
		role: "toolResult",
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		content: message.content,
		isError: message.isError,
		timestamp: message.timestamp,
	};
}

function repairToolPairs(source: readonly AgentMessage[]): AgentMessage[] {
	const repaired: AgentMessage[] = [];
	for (let index = 0; index < source.length; index += 1) {
		const message = source[index];
		if (message === undefined) continue;
		if (message.role === "toolResult") continue;
		if (message.role !== "assistant") {
			repaired.push(message);
			continue;
		}
		const ids = toolCallIds(message);
		const completed = new Set<string>();
		const results: AgentMessage[] = [];
		let nextIndex = index + 1;
		while (ids.size > 0) {
			const next = source[nextIndex];
			if (next === undefined || next.role !== "toolResult") break;
			if (!ids.has(next.toolCallId) || completed.has(next.toolCallId)) break;
			completed.add(next.toolCallId);
			results.push(stripToolResultDetails(next));
			nextIndex += 1;
		}
		const trimmed = trimIncompleteAssistant(message, completed);
		if (trimmed !== undefined) {
			repaired.push(trimmed, ...results);
		}
		index = nextIndex - 1;
	}
	return repaired;
}

function stripUnsupportedImages(
	messages: readonly AgentMessage[],
	allowImages: boolean,
): AgentMessage[] {
	if (allowImages) return [...messages];
	return messages.flatMap((message) => {
		if (message.role !== "user" || !Array.isArray(message.content)) return [message];
		const content = message.content.filter((part) => part.type !== "image");
		if (content.length === message.content.length) return [message];
		return content.length === 0 ? [] : [{ ...message, content }];
	});
}

export function buildAdvisorBootstrapMessages(
	options: AdvisorAdapterOptions,
	budget?: ContextBudget,
	allowImages = false,
): AgentMessage[] {
	if (!hasResolvedContext(options.ctx.sessionManager)) return [];
	const resolved = options.ctx.sessionManager.buildSessionContext();
	const sourceMessages = resolved.messages.filter((message) => !isAdvisorMessage(message));
	const sanitizedSource = stripUnsupportedImages(sourceMessages, allowImages);
	const messages = repairToolPairs(convertToLlm(sanitizedSource));
	return budget === undefined ? messages : repairToolPairs(fitBootstrapMessages(messages, budget));
}

export function createCoreAdvisorAdapter(options: AdvisorAdapterOptions): AdvisorAgentAdapter {
	let agent: Agent | undefined;
	let disposed = true;
	let recreateAfterTimeout = false;
	let inFlightAbort: (() => void) | undefined;
	const adviceByAgent = new WeakMap<Agent, AdvisorAdvice[]>();
	let lifetime: AdvisorUsage = DEFAULT_ADVISOR_USAGE;
	let lastCompactedContextTokens = 0;
	const scheduler = options.scheduler ?? createHostScheduler();
	const currentContextTokens = (target: Agent | undefined = agent): number => {
		if (target === undefined) return 0;
		for (let index = target.state.messages.length - 1; index >= 0; index -= 1) {
			const message = target.state.messages[index];
			if (message?.role !== "assistant" || !message.usage) continue;
			const usage = message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
		return 0;
	};
	const shouldCompact = (target: Agent | undefined = agent): boolean => {
		if (target === undefined) return false;
		const window = target.state.model.contextWindow;
		const tokens = currentContextTokens(target);
		return (
			window > 0 &&
			tokens >= window * ADVISOR_COMPACT_THRESHOLD &&
			tokens > lastCompactedContextTokens
		);
	};
	const createAgent = async (agentOptions: AdvisorAdapterOptions): Promise<Agent> => {
		const collectedAdvice: AdvisorAdvice[] = [];
		const adviseTool: AgentTool<typeof ADVISE_PARAMETERS> = {
			name: "advise",
			label: "Advisor feedback",
			description: "Submit a structured review note to the primary agent.",
			parameters: ADVISE_PARAMETERS,
			execute: async (_id, params, signal) => {
				signal?.throwIfAborted();
				const parsed = parseAdvice(params);
				if (!parsed) throw new Error("Invalid advice");
				collectedAdvice.push(parsed);
				return { content: [{ type: "text", text: "Advice recorded." }], details: {} };
			},
		};
		const model = resolveModel(agentOptions);
		const next =
			agentOptions.testSessionFactory === undefined
				? new Agent({
						sessionId: advisorSessionId(agentOptions.ctx.sessionManager.getSessionId()),
						initialState: {
							systemPrompt: ADVISOR_SYSTEM_PROMPT,
							model,
							thinkingLevel: resolveThinking(agentOptions, model),
							tools: [adviseTool, ...createReadOnlyTools(agentOptions.ctx.cwd)],
						},
						convertToLlm,
						getApiKey: (provider) => agentOptions.ctx.modelRegistry.getApiKeyForProvider(provider),
						streamFn: streamSimple,
					})
				: (await agentOptions.testSessionFactory.create(new AbortController().signal)).agent;
		next.state.messages = buildAdvisorBootstrapMessages(
			agentOptions,
			modelContextBudget(model),
			model.input.includes("image"),
		);
		adviceByAgent.set(next, collectedAdvice);
		return next;
	};
	const create = async (): Promise<void> => {
		if (agent !== undefined) return;
		agent = await createAgent(options);
		disposed = false;
		recreateAfterTimeout = false;
	};
	const disposeAdapter = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		recreateAfterTimeout = false;
		inFlightAbort?.();
		const current = agent;
		agent = undefined;
		current?.abort();
		if (current !== undefined) void current.waitForIdle().catch(() => undefined);
	};
	const resetAdapter = async (): Promise<void> => {
		await disposeAdapter();
		lifetime = DEFAULT_ADVISOR_USAGE;
		lastCompactedContextTokens = 0;
		await create();
	};
	return {
		activeTools: ADVISOR_TOOL_NAMES,
		contextBudget: () => {
			const model = agent?.state.model ?? resolveModel(options);
			return modelContextBudget(model);
		},
		create,
		async reset() {
			await resetAdapter();
		},
		async review(prompt, signal) {
			if (agent === undefined || disposed) {
				if (
					!recreateAfterTimeout ||
					options.model === undefined ||
					options.model.trim().length === 0
				)
					throw new Error("Advisor is not active");
				await create();
			}
			const reviewAgent = agent;
			const reviewOptions = options;
			if (reviewAgent === undefined || disposed) throw new Error("Advisor is not active");
			const reviewAdvice = adviceByAgent.get(reviewAgent);
			if (reviewAdvice === undefined) throw new Error("Advisor state is not initialized");
			signal?.throwIfAborted();
			if (shouldCompact(reviewAgent)) {
				lastCompactedContextTokens = currentContextTokens(reviewAgent);
				reviewAgent.reset();
				reviewAgent.state.messages = buildAdvisorBootstrapMessages(
					reviewOptions,
					modelContextBudget(reviewAgent.state.model),
					reviewAgent.state.model.input.includes("image"),
				);
			}
			reviewAdvice.length = 0;
			let timedOut = false;
			let timeoutError: Error | undefined;
			let rejectTimeout: ((error: Error) => void) | undefined;
			const timeoutFailure = new Promise<never>((_, reject) => {
				rejectTimeout = reject;
			});
			const abort = () => reviewAgent.abort();
			const timeout = scheduler.setTimeout(() => {
				timedOut = true;
				reviewAdvice.length = 0;
				timeoutError = new Error(`Advisor review timed out after ${ADVISOR_REVIEW_TIMEOUT_MS}ms`);
				if (agent === reviewAgent) {
					agent = undefined;
					disposed = true;
					recreateAfterTimeout = true;
				}
				abort();
				rejectTimeout?.(timeoutError);
			}, ADVISOR_REVIEW_TIMEOUT_MS);
			inFlightAbort = abort;
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted === true) abort();
			try {
				let replayedLength = false;
				for (;;) {
					const attemptMessageCount = reviewAgent.state.messages.length;
					let promptFailure: { readonly error: unknown } | undefined;
					try {
						await Promise.race([reviewAgent.prompt(prompt), timeoutFailure]);
					} catch (error) {
						if (timedOut) throw error;
						promptFailure = { error };
					} finally {
						await Promise.race([reviewAgent.waitForIdle(), timeoutFailure]);
						if (!timedOut) {
							for (const message of reviewAgent.state.messages.slice(attemptMessageCount))
								lifetime = addUsage(lifetime, usageFromMessage(message));
						}
					}
					signal?.throwIfAborted();
					if (timedOut) {
						reviewAdvice.length = 0;
						throw new Error(`Advisor review timed out after ${ADVISOR_REVIEW_TIMEOUT_MS}ms`);
					}
					if (promptFailure !== undefined) {
						reviewAdvice.length = 0;
						if (!isLengthError(promptFailure.error)) throw promptFailure.error;
						if (replayedLength)
							throw new Error("Advisor review exceeded the model context after retry");
						replayedLength = true;
						reviewAgent.reset();
						reviewAgent.state.messages = buildAdvisorBootstrapMessages(
							reviewOptions,
							modelContextBudget(reviewAgent.state.model),
							reviewAgent.state.model.input.includes("image"),
						);
						continue;
					}
					const stopReason = finalAssistantStopReason(reviewAgent.state.messages);
					if (stopReason === "length" && !replayedLength) {
						reviewAdvice.length = 0;
						replayedLength = true;
						reviewAgent.reset();
						reviewAgent.state.messages = buildAdvisorBootstrapMessages(
							reviewOptions,
							modelContextBudget(reviewAgent.state.model),
							reviewAgent.state.model.input.includes("image"),
						);
						continue;
					}
					if (stopReason !== "stop" && stopReason !== "toolUse") {
						reviewAdvice.length = 0;
						throw new Error(
							`Advisor review ended with unsupported stop reason: ${stopReason ?? "unknown"}`,
						);
					}
					break;
				}
				return reviewAdvice;
			} finally {
				scheduler.clearTimeout(timeout);
				if (timedOut) reviewAdvice.length = 0;
				signal?.removeEventListener("abort", abort);
				if (inFlightAbort === abort) inFlightAbort = undefined;
			}
		},
		async compact() {
			if (agent === undefined || disposed) return;
			lastCompactedContextTokens = currentContextTokens();
			agent.reset();
			agent.state.messages = buildAdvisorBootstrapMessages(
				options,
				modelContextBudget(agent.state.model),
				agent.state.model.input.includes("image"),
			);
		},
		async abort() {
			inFlightAbort?.();
			const current = agent;
			current?.abort();
			if (current !== undefined) void current.waitForIdle().catch(() => undefined);
		},
		dispose: disposeAdapter,
		usage: () => lifetime,
	};
}
