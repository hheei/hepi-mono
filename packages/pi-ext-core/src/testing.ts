import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";

/**
 * Deterministic model fixture for direct subagent consumer tests. It has no
 * provider side effects; callers own meaningful model and policy overrides.
 */
export function createTestModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		api: "openai-completions",
		id: "test-model",
		name: "Test model",
		provider: "test",
		baseUrl: "http://test.invalid",
		contextWindow: 8_192,
		maxTokens: 1_024,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as Model<Api>;
}

export interface TestAssistantMessageOptions {
	readonly text?: string;
	readonly content?: AssistantMessage["content"];
	readonly stopReason?: AssistantMessage["stopReason"];
	readonly model?: Model<Api>;
	readonly input?: number;
	readonly output?: number;
	readonly totalTokens?: number;
	readonly cost?: number;
}

/** Creates a complete terminal assistant message suitable for scripted model streams. */
export function createAssistantMessage(
	options: TestAssistantMessageOptions = {},
): AssistantMessage {
	const model = options.model ?? createTestModel();
	return {
		role: "assistant",
		content: options.content ?? [{ type: "text", text: options.text ?? "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: options.input ?? 0,
			output: options.output ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: options.totalTokens ?? 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: options.cost ?? 0,
			},
		},
		stopReason: options.stopReason ?? "stop",
		timestamp: 0,
	};
}

export interface ScriptedStream {
	readonly streamFn: StreamFn;
	readonly calls: () => number;
}

/** Returns one terminal message per call, retaining the final step for extra calls. */
export function createScriptedStream(messages: readonly AssistantMessage[]): ScriptedStream {
	let index = 0;
	return {
		streamFn: () => {
			const message = messages[Math.min(index, messages.length - 1)];
			index += 1;
			if (message === undefined) throw new Error("Scripted stream requires at least one message");
			const stream = createAssistantMessageEventStream();
			if (message.stopReason === "error" || message.stopReason === "aborted")
				stream.push({ type: "error", reason: message.stopReason, error: message });
			else stream.push({ type: "done", reason: message.stopReason, message });
			return stream;
		},
		calls: () => index,
	};
}

export interface ControlledStream {
	readonly streamFn: StreamFn;
	readonly calls: () => number;
	resolve(message: AssistantMessage): void;
	fail(message: AssistantMessage): void;
}

/**
 * A manually settled transport fixture. It intentionally does not simulate
 * timeouts; consumers own timeout/scheduler policy and trigger it themselves.
 */
export function createControlledStream(): ControlledStream {
	let calls = 0;
	let current: ReturnType<typeof createAssistantMessageEventStream> | undefined;
	return {
		streamFn: () => {
			if (current !== undefined) throw new Error("Controlled stream already has an active call");
			calls += 1;
			current = createAssistantMessageEventStream();
			return current;
		},
		calls: () => calls,
		resolve(message) {
			if (current === undefined) throw new Error("Controlled stream has no active call");
			const stream = current;
			current = undefined;
			if (message.stopReason === "error" || message.stopReason === "aborted")
				stream.push({ type: "error", reason: message.stopReason, error: message });
			else stream.push({ type: "done", reason: message.stopReason, message });
		},
		fail(message) {
			if (current === undefined) throw new Error("Controlled stream has no active call");
			const stream = current;
			current = undefined;
			const reason =
				message.stopReason === "error" || message.stopReason === "aborted"
					? message.stopReason
					: "error";
			stream.push({ type: "error", reason, error: message });
		},
	};
}
