import type { AgentMessage } from "@earendil-works/pi-agent-core";
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

const ADVISOR_RESPONSE_CAP = 4096;

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

export interface AdvisorAdapterOptions {
	readonly ctx: ExtensionContext;
	readonly lifecycle: ExtensionLifecycleContext;
	readonly model: string | undefined;
	readonly thinking: ThinkingLevel;
}

function resolveModel(options: AdvisorAdapterOptions) {
	const configured = options.model?.trim();
	if (configured === undefined || configured.length === 0)
		throw new Error("Configure an Advisor model in /ext-settings");
	const [provider, id] = configured.split("/", 2);
	if (provider === undefined || id === undefined || provider.length === 0 || id.length === 0)
		throw new Error(`Unavailable Advisor model: ${configured}`);
	const model = options.ctx.modelRegistry.find(provider, id);
	if (model === undefined || model.provider !== provider || model.id !== id)
		throw new Error(`Unavailable Advisor model: ${configured}`);
	if (!options.ctx.modelRegistry.hasConfiguredAuth(model))
		throw new Error(`Advisor model has no configured auth: ${model.provider}/${model.id}`);
	return model;
}

function resolveThinking(
	options: AdvisorAdapterOptions,
	model: ReturnType<typeof resolveModel>,
): ThinkingLevel {
	if (!model.reasoning || options.thinking === "off") return "off";
	if (!getSupportedThinkingLevels(model).includes(options.thinking))
		throw new Error(`Unsupported Advisor thinking level: ${options.thinking}`);
	return options.thinking;
}

function modelContextBudget(model: ReturnType<typeof resolveModel>): ContextBudget {
	return {
		contextWindow: model.contextWindow,
		responseReserve: Math.min(model.maxTokens, ADVISOR_RESPONSE_CAP),
	};
}

function inheritedModelRuntime(ctx: ExtensionContext): ModelRuntime | undefined {
	const registry: unknown = ctx.modelRegistry;
	if (typeof registry !== "object" || registry === null || !("runtime" in registry))
		return undefined;
	return registry.runtime instanceof ModelRuntime ? registry.runtime : undefined;
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
	return content.length === message.content.length ? message : { ...message, content };
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
		if (message === undefined || message.role === "toolResult") continue;
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
		if (trimmed !== undefined) repaired.push(trimmed, ...results);
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
		return content.length === message.content.length
			? [message]
			: content.length === 0
				? []
				: [{ ...message, content }];
	});
}

function fitBootstrapMessages(
	messages: readonly AgentMessage[],
	budget: ContextBudget,
): readonly AgentMessage[] {
	const maxChars = contextInputCharBudget(budget);
	const selected: AgentMessage[] = [];
	let chars = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === undefined) continue;
		const messageChars = JSON.stringify(message).length;
		if (chars + messageChars > maxChars) break;
		selected.unshift(message);
		chars += messageChars;
	}
	if (selected.length === messages.length) return selected;
	if (selected.length === 0 && messages.length > 0)
		throw new Error("Advisor bootstrap context cannot fit the configured model");
	const marker: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "[advisor bootstrap context truncated]" }],
		timestamp: Date.now(),
	};
	if (chars + JSON.stringify(marker).length > maxChars)
		throw new Error("Advisor bootstrap context cannot fit the configured model");
	return [marker, ...selected];
}

function isAdvisorMessage(message: AgentMessage): boolean {
	return "customType" in message && message.customType === "pi-basics-advisory";
}

export function buildAdvisorBootstrapMessages(
	options: AdvisorAdapterOptions,
	budget?: ContextBudget,
	allowImages = false,
): AgentMessage[] {
	if (!hasResolvedContext(options.ctx.sessionManager)) return [];
	const source = options.ctx.sessionManager.buildSessionContext().messages;
	const sanitized = stripUnsupportedImages(
		source.filter((message) => !isAdvisorMessage(message)),
		allowImages,
	);
	const messages = repairToolPairs(convertToLlm(sanitized));
	return budget === undefined ? messages : repairToolPairs(fitBootstrapMessages(messages, budget));
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
				sessionManager: SessionManager.inMemory(options.ctx.cwd),
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: false },
					retry: { enabled: false },
				}),
				...(modelRuntime === undefined ? {} : { modelRuntime }),
			});
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
	let disposed = false;
	const ensureFactory = (): ResolvedChildSessionFactory => {
		if (factory !== undefined) return factory;
		const resolved = resolveModel(options);
		model = resolved;
		factory = createAdvisorSessionFactory(options, resolved, resolveThinking(options, resolved));
		return factory;
	};
	const cancel = (): void => handle?.cancel();
	const withAbort = async <T>(
		signal: AbortSignal | undefined,
		operation: () => Promise<T>,
	): Promise<T> => {
		if (signal?.aborted === true) {
			cancel();
			throw abortError();
		}
		const abort = (): void => cancel();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			return await operation();
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	};
	const reply = async (prompt: string, signal: AbortSignal | undefined) => {
		if (disposed) throw new Error("Advisor is not active");
		if (handle === undefined) {
			handle = startSubagent(options.lifecycle, {
				mode: "conversation",
				session: ensureFactory(),
				initialMessage: prompt,
				initialReply: { kind: "wait", signal: signal ?? new AbortController().signal },
				fallbackDelivery: () => undefined,
				maxTurnsPerReply: 8,
			});
			return await withAbort(signal, () => handle.initialReply);
		}
		return await withAbort(signal, () =>
			handle.send(prompt, {
				inputMode: "queue",
				reply: { kind: "wait", signal: signal ?? new AbortController().signal },
			}),
		);
	};
	return {
		activeTools: ADVISOR_TOOL_NAMES,
		async create() {
			ensureFactory();
			disposed = false;
		},
		async reset() {
			cancel();
			handle = undefined;
			disposed = false;
		},
		async review(prompt, signal) {
			const result = await reply(prompt, signal);
			if (result.status !== "completed") {
				if (result.status === "cancelled") throw abortError();
				throw new Error(result.failure ?? `Advisor review ${result.status}`);
			}
			return parseAdvisorReview(result.output);
		},
		async compact() {},
		async abort() {
			cancel();
		},
		async dispose() {
			disposed = true;
			cancel();
			handle = undefined;
		},
		usage: () => DEFAULT_ADVISOR_USAGE,
		contextBudget: () => modelContextBudget(model ?? resolveModel(options)),
	};
}
