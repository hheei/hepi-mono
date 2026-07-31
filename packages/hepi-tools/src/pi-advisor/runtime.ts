import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type ConversationSubagentHandle,
	type ExtensionLifecycleContext,
	type ResolvedChildSessionFactory,
	startSubagent,
} from "@hheei/pi-ext-core";
import { type ContextBudget, contextInputCharBudget } from "./context.js";
import {
	ADVISOR_TOOL_NAMES,
	type AdvisorAdvice,
	type AdvisorUsage,
	DEFAULT_ADVISOR_USAGE,
	parseAdvisorReview,
	type ThinkingLevel,
} from "./model.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";

const ADVISOR_REVIEW_TIMEOUT_MS = 30_000;
const ADVISOR_COMPACT_THRESHOLD = 0.8;
const ADVISOR_RESPONSE_CAP = 4096;
const ADVISOR_SESSION_PREFIX = "pi-basics-advisor:";

export function advisorSessionId(primarySessionId: string): string {
	return `${ADVISOR_SESSION_PREFIX}${primarySessionId}`;
}

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
	readonly lifecycle: ExtensionLifecycleContext;
	readonly model: string | undefined;
	readonly thinking: ThinkingLevel;
	/** Test-only transport injection; production uses Agent's default stream. */
	readonly streamFn?: StreamFn;
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

function inheritedModelRuntime(ctx: ExtensionContext): ModelRuntime | undefined {
	const registry: unknown = ctx.modelRegistry;
	if (typeof registry !== "object" || registry === null || !("runtime" in registry))
		return undefined;
	return registry.runtime instanceof ModelRuntime ? registry.runtime : undefined;
}

function createAdvisorSessionFactory(
	options: AdvisorAdapterOptions,
	model: ReturnType<typeof resolveModel>,
	thinking: ThinkingLevel,
): ResolvedChildSessionFactory {
	const budget = modelContextBudget(model);
	return {
		async create(signal) {
			signal.throwIfAborted();
			const agentDir = getAgentDir();
			const loader = new DefaultResourceLoader({
				cwd: options.ctx.cwd,
				agentDir,
				systemPromptOverride: () => ADVISOR_SYSTEM_PROMPT,
				appendSystemPromptOverride: () => [],
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await loader.reload();
			const modelRuntime = inheritedModelRuntime(options.ctx);
			const { session } = await createAgentSession({
				cwd: options.ctx.cwd,
				agentDir,
				model,
				thinkingLevel: thinking,
				tools: [...ADVISOR_TOOL_NAMES],
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(options.ctx.cwd, {
					id: advisorSessionId(options.ctx.sessionManager.getSessionId()),
				}),
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: false },
					retry: { enabled: false },
				}),
				...(modelRuntime === undefined ? {} : { modelRuntime }),
			});
			if (options.streamFn !== undefined) {
				// Pi does not expose a stream override on AgentSession; tests inject transport here.
				(session.agent as unknown as { streamFunction: StreamFn }).streamFunction =
					options.streamFn;
			}
			if (signal.aborted) {
				session.dispose();
				signal.throwIfAborted();
			}
			session.state.messages.splice(
				0,
				session.state.messages.length,
				...buildAdvisorBootstrapMessages(options, budget, model.input.includes("image")),
			);
			return session;
		},
	};
}

function abortError(): Error {
	return new Error("Advisor review aborted");
}

export function createCoreAdvisorAdapter(options: AdvisorAdapterOptions): AdvisorAgentAdapter {
	let model: ReturnType<typeof resolveModel> | undefined;
	let factory: ResolvedChildSessionFactory | undefined;
	let handle: ConversationSubagentHandle | undefined;
	let disposed = true;
	let lifetime: AdvisorUsage = DEFAULT_ADVISOR_USAGE;
	let observedUsage: AdvisorUsage = DEFAULT_ADVISOR_USAGE;
	let latestContextTokens = 0;
	let lastCompactedContextTokens = 0;
	let inFlightAbort: (() => void) | undefined;
	const scheduler = options.scheduler ?? createHostScheduler();
	const ensureFactory = (): ResolvedChildSessionFactory => {
		if (factory !== undefined) return factory;
		const resolved = resolveModel(options);
		model = resolved;
		factory = createAdvisorSessionFactory(options, resolved, resolveThinking(options, resolved));
		return factory;
	};
	const recordUsage = (): void => {
		if (handle === undefined) return;
		const next = handle.usage();
		latestContextTokens = Math.max(0, next.input - observedUsage.input);
		observedUsage = next;
	};
	const retireHandle = (): void => {
		if (handle === undefined) return;
		recordUsage();
		lifetime = addUsage(lifetime, observedUsage);
		handle.cancel();
		handle = undefined;
		observedUsage = DEFAULT_ADVISOR_USAGE;
	};
	const shouldCompact = (): boolean => {
		const window = (model ?? resolveModel(options)).contextWindow;
		return (
			window > 0 &&
			latestContextTokens >= window * ADVISOR_COMPACT_THRESHOLD &&
			latestContextTokens > lastCompactedContextTokens
		);
	};
	const withAbort = async <T>(
		signal: AbortSignal | undefined,
		operation: () => Promise<T>,
	): Promise<T> => {
		if (signal?.aborted === true) throw abortError();
		const abort = (): void => inFlightAbort?.();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			return await operation();
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	};
	const send = async (prompt: string, signal: AbortSignal | undefined) => {
		if (handle === undefined) {
			handle = startSubagent(options.lifecycle, {
				mode: "conversation",
				session: ensureFactory(),
				initialMessage: prompt,
				initialReply: { kind: "wait", signal: signal ?? new AbortController().signal },
				fallbackDelivery: () => undefined,
				maxTurnsPerReply: 8,
			});
			return await handle.initialReply;
		}
		return await handle.send(prompt, {
			inputMode: "queue",
			reply: { kind: "wait", signal: signal ?? new AbortController().signal },
		});
	};
	return {
		activeTools: ADVISOR_TOOL_NAMES,
		contextBudget: () => modelContextBudget(model ?? resolveModel(options)),
		async create() {
			ensureFactory();
			disposed = false;
		},
		async reset() {
			retireHandle();
			lifetime = DEFAULT_ADVISOR_USAGE;
			latestContextTokens = 0;
			lastCompactedContextTokens = 0;
			disposed = false;
		},
		async review(prompt, signal) {
			if (disposed) throw new Error("Advisor is not active");
			if (shouldCompact() && handle !== undefined) {
				lastCompactedContextTokens = latestContextTokens;
				await handle.compact();
			}
			let timedOut = false;
			let rejectTimeout: ((error: Error) => void) | undefined;
			const timeoutFailure = new Promise<never>((_, reject) => {
				rejectTimeout = reject;
			});
			const abort = (): void => handle?.cancel();
			const timeout = scheduler.setTimeout(() => {
				timedOut = true;
				abort();
				rejectTimeout?.(new Error(`Advisor review timed out after ${ADVISOR_REVIEW_TIMEOUT_MS}ms`));
			}, ADVISOR_REVIEW_TIMEOUT_MS);
			inFlightAbort = abort;
			try {
				const result = await withAbort(signal, () =>
					Promise.race([send(prompt, signal), timeoutFailure]),
				);
				recordUsage();
				if (result.status !== "completed") {
					if (result.status === "cancelled") throw abortError();
					throw new Error(result.failure ?? `Advisor review ${result.status}`);
				}
				return parseAdvisorReview(result.output);
			} finally {
				scheduler.clearTimeout(timeout);
				if (timedOut) retireHandle();
				if (inFlightAbort === abort) inFlightAbort = undefined;
			}
		},
		async compact() {
			if (handle === undefined || disposed) return;
			lastCompactedContextTokens = latestContextTokens;
			await handle.compact();
		},
		async abort() {
			inFlightAbort?.();
			handle?.cancel();
		},
		async dispose() {
			disposed = true;
			retireHandle();
		},
		usage: () => (handle === undefined ? lifetime : addUsage(lifetime, handle.usage())),
	};
}
