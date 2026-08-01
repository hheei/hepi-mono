import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import { type CompletionSubagentHandle, openTuiSurface, startSubagent } from "@hheei/pi-ext-core";
import { type BtwComponentController, createBtwComponent } from "./component.js";
import type { BtwExecutionResult, executeBtwTurn } from "./executor.js";
import {
	type BtwRequestToken,
	type BtwTurn,
	buildBtwMessages,
	createBtwTurn,
	normalizeBtwQuestion,
} from "./model.js";
import { BTW_SYSTEM_PROMPT } from "./prompt.js";

export const BTW_COMMAND_NAME = "btw";

/**
 * Owns one session's BTW history and at most one active request. Core supplies
 * child execution and serialized custom-surface access; this feature decides what
 * history means, when requests are invalidated, and how results reach the view.
 */
export interface BtwFeature {
	start(runtime: ExtensionLifecycleContext): void;
	dispose(sessionId: string): void;
}

export interface BtwFeatureOptions {
	readonly execute?: typeof executeBtwTurn;
	readonly createComponent?: typeof createBtwComponent;
}

interface ActiveRequest {
	readonly token: BtwRequestToken;
	readonly controller: AbortController;
	handle?: CompletionSubagentHandle;
	component?: BtwComponentController;
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

interface ActiveRuntime {
	readonly sessionId: string;
	readonly runtime: ExtensionLifecycleContext;
	readonly runtimeRevision: number;
	turns: BtwTurn[];
	contextRevision: number;
	historyGeneration: number;
	requestRevision: number;
	activeRequest?: ActiveRequest | undefined;
	disposed: boolean;
}

function isSameSession(
	current: ActiveRuntime | undefined,
	ctx: ExtensionContext,
): current is ActiveRuntime {
	return !!current && !current.disposed && current.sessionId === ctx.sessionManager.getSessionId();
}

function isCurrentRequest(current: ActiveRuntime, request: ActiveRequest): boolean {
	const { token } = request;
	return (
		!current.disposed &&
		current.activeRequest === request &&
		current.sessionId === token.sessionId &&
		current.runtimeRevision === token.runtimeRevision &&
		current.contextRevision === token.contextRevision &&
		current.historyGeneration === token.historyGeneration &&
		current.requestRevision === token.requestRevision
	);
}

function abortRequest(current: ActiveRuntime, closeOverlay: boolean): void {
	// Abort both layers: the local controller stops injected executors while the
	// core handle stops a real child session. Closing the overlay is policy-driven.
	const request = current.activeRequest;
	if (!request) return;
	request.controller.abort();
	request.handle?.cancel();
	if (closeOverlay) request.component?.close();
}

async function executeCoreCompletion(
	runtime: ActiveRuntime,
	request: ActiveRequest,
	model: Model<Api>,
	messages: ReturnType<typeof buildBtwMessages>,
): Promise<BtwExecutionResult> {
	const handle = startSubagent(runtime.runtime, {
		mode: "completion",
		model,
		prompt: "",
		messages: [...messages],
		systemPrompt: BTW_SYSTEM_PROMPT,
		thinkingLevel: "off",
	});
	request.handle = handle;
	const result = await handle.result;
	if (result.status === "cancelled") return { status: "aborted" };
	if (result.status !== "completed")
		return {
			status: "error",
			message: result.status === "failed" ? result.failure.message : "The BTW request failed",
		};
	const response: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: result.output }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return { status: "success", response, text: result.output };
}

function terminalRows(): number {
	return Math.max(8, process.stdout.rows ?? 24);
}

function btwOverlayOptions(): {
	readonly width: "72%" | "82%" | "94%";
	readonly maxHeight: "45%" | "50%" | "60%";
	readonly margin: 1;
} {
	const columns = Math.max(8, process.stdout.columns ?? 80);
	const rows = terminalRows();
	if (columns < 100 || rows < 24) return { width: "94%", maxHeight: "60%", margin: 1 };
	if (columns >= 120 && rows >= 40) return { width: "72%", maxHeight: "45%", margin: 1 };
	return { width: "82%", maxHeight: "50%", margin: 1 };
}

export function createBtwFeature(pi: ExtensionAPI, options: BtwFeatureOptions = {}): BtwFeature {
	const execute = options.execute;
	const createComponent = options.createComponent ?? createBtwComponent;
	let active: ActiveRuntime | undefined;
	let runtimeRevision = 0;

	const invalidateContext = (current: ActiveRuntime, closeOverlay: boolean): void => {
		current.contextRevision++;
		abortRequest(current, closeOverlay);
	};

	const clearHistory = (current: ActiveRuntime): void => {
		current.historyGeneration++;
		current.turns = [];
		abortRequest(current, false);
	};

	const runRequest = async (
		current: ActiveRuntime,
		request: ActiveRequest,
		question: string,
	): Promise<void> => {
		try {
			const model = current.runtime.extension.model;
			if (!model) {
				if (isCurrentRequest(current, request)) request.component?.setError("No model is selected");
				return;
			}
			if (!hasResolvedContext(current.runtime.extension.sessionManager)) {
				throw new Error("BTW session context API is unavailable");
			}
			const sessionContext = current.runtime.extension.sessionManager.buildSessionContext();
			const messages = buildBtwMessages({
				mainMessages: convertToLlm(sessionContext.messages),
				turns: current.turns,
				question,
			});
			const result =
				execute === undefined
					? await executeCoreCompletion(current, request, model as Model<Api>, [...messages])
					: await execute({
							model: model as Model<Api>,
							modelRegistry: current.runtime.extension.modelRegistry,
							messages: [...messages],
							signal: request.controller.signal,
						});
			if (!isCurrentRequest(current, request)) return;
			// biome-ignore-start lint/suspicious/noUnnecessaryConditions: Injected executors return the full result union at runtime.
			switch (result.status) {
				case "success":
					current.turns = [...current.turns, createBtwTurn(question, result.response)];
					request.component?.setAnswer(result.text);
					return;
				case "aborted":
					request.component?.close();
					return;
				case "error":
					request.component?.setError(result.message);
					return;
				default:
					return result satisfies never;
			}
			// biome-ignore-end lint/suspicious/noUnnecessaryConditions: Injected executors return the full result union at runtime.
		} catch (error: unknown) {
			if (!isCurrentRequest(current, request)) return;
			if (request.controller.signal.aborted) {
				request.component?.close();
				return;
			}
			request.component?.setError(
				error instanceof Error ? error.message : "The BTW request failed",
			);
		}
	};

	pi.registerCommand(BTW_COMMAND_NAME, {
		description: "Ask a read-only side question about the current session",
		handler: async (args, ctx) => {
			const current = active;
			if (!isSameSession(current, ctx)) {
				ctx.ui.notify("BTW runtime is not active", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("BTW is available only in the TUI", "warning");
				return;
			}
			let question: string;
			try {
				question = normalizeBtwQuestion(args);
			} catch (error: unknown) {
				ctx.ui.notify(error instanceof Error ? error.message : "Invalid BTW question", "warning");
				return;
			}
			if (current.activeRequest) {
				ctx.ui.notify("A BTW question is already open", "warning");
				return;
			}
			if (question && !ctx.model) {
				ctx.ui.notify("/btw requires an active model", "error");
				return;
			}
			const request: ActiveRequest = {
				token: {
					sessionId: current.sessionId,
					runtimeRevision: current.runtimeRevision,
					contextRevision: current.contextRevision,
					historyGeneration: current.historyGeneration,
					requestRevision: ++current.requestRevision,
				},
				controller: new AbortController(),
			};
			current.activeRequest = request;
			try {
				// The core surface owns admission/close. The feature factory creates its
				// own component only after admission, so queued requests retain no stale UI.
				await openTuiSurface(pi, ctx, {
					hostId: "@hheei/pi-btw/btw",
					signal: request.controller.signal,
					maxPending: 1,
					overlay: true,
					overlayOptions: btwOverlayOptions,
					create: ({ tui, theme, close }) => {
						const component = createComponent({
							question,
							history: current.turns,
							theme,
							host: { requestRender: () => tui.requestRender(), getTerminalRows: terminalRows },
							done: () => close(undefined),
							onClearHistory: () => {
								if (isCurrentRequest(current, request)) clearHistory(current);
							},
						});
						request.component = component;
						if (question) void runRequest(current, request, question);
						return component;
					},
				});
			} finally {
				if (current.activeRequest === request) {
					request.controller.abort();
					current.activeRequest = undefined;
				}
			}
		},
	});

	for (const eventName of [
		"session_before_compact",
		"session_before_switch",
		"session_before_fork",
		"session_before_tree",
		"session_tree",
		"session_compact",
		"session_shutdown",
	] as const) {
		// Pi keeps these handlers across reload. `isSameSession` and the active
		// runtime token turn old handlers into no-ops after lifecycle disposal.
		pi.on(eventName as never, async (_event: unknown, ctx: ExtensionContext) => {
			const current = active;
			if (isSameSession(current, ctx)) invalidateContext(current, true);
		});
	}

	return {
		start(runtime): void {
			const previous = active;
			if (previous) {
				previous.disposed = true;
				abortRequest(previous, true);
			}
			active = {
				sessionId: runtime.extension.sessionManager.getSessionId(),
				runtime,
				runtimeRevision: ++runtimeRevision,
				turns: [],
				contextRevision: 0,
				historyGeneration: 0,
				requestRevision: 0,
				disposed: false,
			};
		},
		dispose(sessionId): void {
			const current = active;
			if (!current || current.sessionId !== sessionId) return;
			current.disposed = true;
			invalidateContext(current, true);
			if (active === current) active = undefined;
		},
	};
}
