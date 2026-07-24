import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { createHePiRuntimeContext, type HePiRuntimeContext } from "@hheei/pi-basics";
import type { BtwComponentController, BtwComponentOptions } from "../src/component.js";
import type { BtwExecutionResult, ExecuteBtwTurnOptions } from "../src/executor.js";
import { type BtwFeatureOptions, createBtwFeature } from "../src/feature.js";

type Command = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type ComponentState = {
	readonly options: BtwComponentOptions;
	readonly component: BtwComponentController;
	answer: string | undefined;
	error: string | undefined;
	closeCount: number;
};
type PendingExecution = {
	readonly options: ExecuteBtwTurnOptions;
	readonly resolve: (result: BtwExecutionResult) => void;
};
type TestModel = Model<Api>;

const model = { provider: "test", id: "test-model", api: "test" } as TestModel;

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function at<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`Expected fixture item at index ${index}`);
	return item;
}

function first<T>(items: readonly T[]): T {
	return at(items, 0);
}

function forbidden(name: string): never {
	throw new Error(`${name} must not be called by the BTW feature`);
}

interface FixtureOptions {
	readonly sessionId?: string;
	readonly mode?: "tui" | "rpc";
	readonly hasModel?: boolean;
}

function fixture(options: FixtureOptions = {}) {
	const commands: Command[] = [];
	const handlers = new Map<string, EventHandler>();
	const executions: PendingExecution[] = [];
	const components: ComponentState[] = [];
	const notifications: Array<{ readonly message: string; readonly level?: string }> = [];
	const currentModel: TestModel | undefined = options.hasModel === false ? undefined : model;
	let currentSessionId = options.sessionId ?? "btw-session";
	let customOpened = 0;
	let customResolved = 0;
	let aborted = 0;

	const sessionManager = {
		getSessionId: () => currentSessionId,
		buildSessionContext: () => ({ messages: [] }),
		appendEntry: () => forbidden("sessionManager.appendEntry"),
		sendMessage: () => forbidden("sessionManager.sendMessage"),
		sendUserMessage: () => forbidden("sessionManager.sendUserMessage"),
		setActiveTools: () => forbidden("sessionManager.setActiveTools"),
	};
	const pi = {
		registerCommand: (_name: string, options: Command) => {
			commands.push(options);
		},
		on: (name: string, handler: EventHandler) => {
			handlers.set(name, handler);
		},
		appendEntry: () => forbidden("appendEntry"),
		sendMessage: () => forbidden("sendMessage"),
		sendUserMessage: () => forbidden("sendUserMessage"),
		setActiveTools: () => forbidden("setActiveTools"),
	};
	const typedPi = pi as unknown as ExtensionAPI;
	const ctx = {
		get model() {
			return currentModel;
		},
		mode: options.mode ?? "tui",
		hasUI: true,
		cwd: "/tmp/btw",
		signal: undefined,
		sessionManager,
		modelRegistry: {} as unknown as ModelRegistry,
		ui: {
			notify: (message: string, level?: "info" | "warning" | "error") => {
				notifications.push(level === undefined ? { message } : { message, level });
			},
			custom<T>(
				factory: (
					tui: never,
					theme: never,
					keybindings: never,
					done: (result: T) => void,
				) => BtwComponentController | Promise<BtwComponentController>,
			): Promise<T> {
				customOpened++;
				return new Promise<T>((resolve, reject) => {
					void Promise.resolve(
						factory(undefined as never, undefined as never, undefined as never, (result: T) => {
							customResolved++;
							resolve(result);
						}),
					).catch(reject);
				});
			},
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {
			aborted++;
		},
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
	};
	const typedCtx = ctx as unknown as ExtensionCommandContext;
	const runtime: HePiRuntimeContext = createHePiRuntimeContext(typedPi, typedCtx, {} as never);
	const execute: NonNullable<BtwFeatureOptions["execute"]> = async (
		options: ExecuteBtwTurnOptions,
	) =>
		new Promise<BtwExecutionResult>((resolve) => {
			executions.push({ options, resolve });
		});
	const createComponent: NonNullable<BtwFeatureOptions["createComponent"]> = (
		options: BtwComponentOptions,
	) => {
		let closed = false;
		const state = {} as ComponentState;
		const close = (): void => {
			if (closed) return;
			closed = true;
			state.closeCount++;
			options.done();
		};
		const component: BtwComponentController = {
			render: () => [],
			invalidate: () => undefined,
			setAnswer: (text: string) => {
				if (!closed) state.answer = text;
			},
			setError: (message: string) => {
				if (!closed) state.error = message;
			},
			close,
			dispose: close,
		};
		Object.assign(state, {
			options,
			component,
			answer: undefined,
			error: undefined,
			closeCount: 0,
		});
		components.push(state);
		return component;
	};
	const feature = createBtwFeature(typedPi, { execute, createComponent });

	return {
		aborted: () => aborted,
		commandCtx: typedCtx,
		commands,
		components,
		customOpened: () => customOpened,
		customResolved: () => customResolved,
		executions,
		feature,
		handlers,
		notifications,
		runtime,
		setSessionId: (value: string) => {
			currentSessionId = value;
		},
	};
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function emit(harness: ReturnType<typeof fixture>, eventName: string): Promise<void> {
	await harness.handlers.get(eventName)?.({}, harness.runtime.ctx);
}

function resolveExecution(
	harness: ReturnType<typeof fixture>,
	index: number,
	result: BtwExecutionResult,
): void {
	const execution = harness.executions[index];
	if (execution === undefined) throw new Error(`Expected execution ${index}`);
	execution.resolve(result);
}

describe("BTW feature", () => {
	test("empty question opens the history panel without executing", async () => {
		const h = fixture();
		h.feature.start(h.runtime);
		const pending = first(h.commands).handler("   ", h.commandCtx);
		await settle();
		expect(h.customOpened()).toBe(1);
		expect(h.executions).toHaveLength(0);
		at(h.components, 0).component.close();
		await pending;
	});

	test("non-TUI mode does not open custom UI or execute", async () => {
		const h = fixture({ mode: "rpc" });
		h.feature.start(h.runtime);
		await first(h.commands).handler("question", h.commandCtx);
		expect(h.customOpened()).toBe(0);
		expect(h.executions).toHaveLength(0);
	});

	test("missing model does not open custom UI or execute", async () => {
		const h = fixture({ hasModel: false });
		h.feature.start(h.runtime);
		await first(h.commands).handler("question", h.commandCtx);
		expect(h.customOpened()).toBe(0);
		expect(h.executions).toHaveLength(0);
	});

	test("allows only one active request at a time", async () => {
		const h = fixture();
		h.feature.start(h.runtime);
		const firstRequest = first(h.commands).handler("first", h.commandCtx);
		await settle();
		await first(h.commands).handler("second", h.commandCtx);
		expect(h.executions).toHaveLength(1);
		expect(h.notifications.at(-1)).toEqual({
			message: "A BTW question is already open",
			level: "warning",
		});
		resolveExecution(h, 0, { status: "aborted" });
		await firstRequest;
	});

	test("success is added to the next history, but an error is not", async () => {
		const h = fixture();
		h.feature.start(h.runtime);
		const firstRequest = first(h.commands).handler("successful question", h.commandCtx);
		await settle();
		resolveExecution(h, 0, {
			status: "success",
			response: assistant("previous answer"),
			text: "previous answer",
		});
		await settle();
		expect(at(h.components, 0).answer).toBe("previous answer");
		at(h.components, 0).component.close();
		await firstRequest;

		const secondRequest = first(h.commands).handler("failed question", h.commandCtx);
		await settle();
		const secondExecution = h.executions[1];
		if (secondExecution === undefined) throw new Error("Expected second execution");
		expect(JSON.stringify(secondExecution.options.messages)).toContain("successful question");
		expect(JSON.stringify(secondExecution.options.messages)).toContain("previous answer");
		resolveExecution(h, 1, { status: "error", message: "provider failed" });
		await settle();
		expect(at(h.components, 1).error).toBe("provider failed");
		at(h.components, 1).component.close();
		await secondRequest;

		const thirdRequest = first(h.commands).handler("next question", h.commandCtx);
		await settle();
		const thirdExecution = h.executions[2];
		if (thirdExecution === undefined) throw new Error("Expected third execution");
		expect(JSON.stringify(thirdExecution.options.messages)).not.toContain("failed question");
		at(h.components, 2).component.close();
		resolveExecution(h, 2, { status: "aborted" });
		await thirdRequest;
	});

	test("an aborted result closes the overlay", async () => {
		const h = fixture();
		h.feature.start(h.runtime);
		const request = first(h.commands).handler("question", h.commandCtx);
		await settle();
		resolveExecution(h, 0, { status: "aborted" });
		await settle();
		expect(h.components[0]?.closeCount).toBe(1);
		expect(h.customResolved()).toBe(1);
		await request;
	});

	test("clearing history aborts pending work and ignores its late success", async () => {
		const h = fixture();
		h.feature.start(h.runtime);
		const request = first(h.commands).handler("old question", h.commandCtx);
		await settle();
		const component = h.components[0];
		if (component === undefined) throw new Error("Expected component");
		component.options.onClearHistory();
		expect(at(h.executions, 0).options.signal.aborted).toBe(true);
		resolveExecution(h, 0, {
			status: "success",
			response: assistant("stale answer"),
			text: "stale answer",
		});
		await settle();
		expect(component.answer).toBeUndefined();
		component.component.close();
		await request;

		const nextRequest = first(h.commands).handler("new question", h.commandCtx);
		await settle();
		expect(JSON.stringify(at(h.executions, 1).options.messages)).not.toContain("old question");
		component.component.close();
		resolveExecution(h, 1, { status: "aborted" });
		await nextRequest;
	});

	test.each([
		"session_before_tree",
		"session_before_compact",
	] as const)("%s aborts and closes the overlay, and ignores late results", async (eventName) => {
		const h = fixture();
		h.feature.start(h.runtime);
		const request = first(h.commands).handler("question", h.commandCtx);
		await settle();
		await emit(h, eventName);
		const component = h.components[0];
		if (component === undefined) throw new Error("Expected component");
		expect(at(h.executions, 0).options.signal.aborted).toBe(true);
		expect(h.aborted()).toBe(0);
		expect(component.closeCount).toBe(1);
		resolveExecution(h, 0, {
			status: "success",
			response: assistant("stale answer"),
			text: "stale answer",
		});
		await settle();
		expect(component.answer).toBeUndefined();
		await request;
	});

	test("dispose aborts, closes custom UI, and isolates the old callback", async () => {
		const h = fixture({ sessionId: "old-session" });
		h.feature.start(h.runtime);
		const oldRequest = first(h.commands).handler("old question", h.commandCtx);
		await settle();
		const oldComponent = h.components[0];
		if (oldComponent === undefined) throw new Error("Expected old component");
		h.feature.dispose("old-session");
		expect(at(h.executions, 0).options.signal.aborted).toBe(true);
		expect(oldComponent.closeCount).toBe(1);
		resolveExecution(h, 0, {
			status: "success",
			response: assistant("stale answer"),
			text: "stale answer",
		});
		await settle();
		expect(oldComponent.answer).toBeUndefined();
		await oldRequest;

		h.setSessionId("new-session");
		h.feature.start(h.runtime);
		const newRequest = first(h.commands).handler("new question", h.commandCtx);
		await settle();
		expect(h.executions).toHaveLength(2);
		expect(JSON.stringify(at(h.executions, 1).options.messages)).not.toContain("old question");
		at(h.components, 1).component.close();
		resolveExecution(h, 1, { status: "aborted" });
		await newRequest;
	});
});
