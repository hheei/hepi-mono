import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type {
	HePiRuntimeContext,
	ToolActivationCoordinator,
} from "../../../hepi-basics/src/core/index.js";
import { createAskComponent } from "./component.js";
import { hasDialogUI, runAskFallback } from "./fallback.js";
import {
	type AskInteractionResult,
	type AskQuestionnaire,
	formatAskResult,
	normalizeAskParams,
} from "./model.js";

const askOption = Type.Object(
	{
		label: Type.String({ minLength: 1, maxLength: 60 }),
		description: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
	},
	{ additionalProperties: false },
);
const askQuestion = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 64 }),
		question: Type.String({ minLength: 1, maxLength: 500 }),
		options: Type.Array(askOption, { minItems: 2, maxItems: 5 }),
		multi: Type.Optional(Type.Boolean()),
		recommended: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false },
);
export const ASK_PARAMETERS = Type.Object(
	{
		context: Type.Optional(Type.String({ maxLength: 2000 })),
		questions: Type.Array(askQuestion, { minItems: 1, maxItems: 4 }),
	},
	{ additionalProperties: false },
);

export const ASK_TOOL_NAME = "ask";
export const ASK_TOOL_LABEL = "Ask";
export const ASK_TOOL_DESCRIPTION =
	"Ask user 1-4 related questions when evidence cannot resolve a material decision. Supports single-select, multi-select, automatic `Other`, and final review. Requires interactive UI.";
export const ASK_PROMPT_SNIPPET = "Request a focused user decision after gathering evidence";
export const ASK_PROMPT_GUIDELINES = [
	"MUST inspect code, config, docs, and prior decisions first. NEVER ask for facts available through tools.",
	"Use `ask` only for materially different options requiring user preference or authorization boundary. If several choices work, choose the conservative default and continue.",
	"Keep one questionnaire per decision boundary. Group related questions in one call. Use `context` only for concise facts shared by all questions. NEVER batch unrelated decisions or repeat without new ambiguity.",
	"Provide 2-5 concise options. Put trade-offs in descriptions, not labels. Set `multi: true` for multiple selections; omit it for single-select. Set `recommended` to the preferred zero-based index; it sets focus, not an answer. NEVER add `(Recommended)` to labels.",
	"The UI adds `Other (type your own)` automatically; NEVER author it. After submission, use returned answers and continue. Cancellation or abort yields no decision or consent; NEVER infer either or continue irreversible work that depends on it.",
	"`ask` clarifies decisions only. It NEVER grants tool permission or bypasses host approval rules.",
] as const;

export interface AskFeature {
	start(runtime: HePiRuntimeContext): void | Promise<void>;
	dispose(sessionId: string): void | Promise<void>;
	requestAsk(questionnaire: AskQuestionnaire, signal?: AbortSignal): Promise<AskInteractionResult>;
}

interface ActiveAsk {
	readonly sessionId: string;
	readonly abort: AbortController;
	component?: { dispose(): void };
}

function textComponent(value: string): Component {
	return new Text(value, 0, 0);
}

function resultText(result: AgentToolResultLike): string {
	return (
		result.content
			?.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n") ?? ""
	);
}

type AgentToolResultLike = { content?: readonly { type: string; text?: string }[] };

export function createAskFeature(
	pi: ExtensionAPI,
	coordinator: ToolActivationCoordinator,
): AskFeature {
	let activeRuntime: HePiRuntimeContext | undefined;
	let activeAsk: ActiveAsk | undefined;
	const requestAsk = async (
		questionnaire: AskQuestionnaire,
		signal?: AbortSignal,
	): Promise<AskInteractionResult> => {
		const runtime = activeRuntime;
		if (!runtime) throw new Error("Ask runtime is not active");
		if (activeAsk) throw new Error("Ask is already active");
		if (signal?.aborted) signal.throwIfAborted();
		const abort = new AbortController();
		const onAbort = () => abort.abort(signal?.reason);
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		const current: ActiveAsk = { sessionId: runtime.ctx.sessionManager.getSessionId(), abort };
		activeAsk = current;
		try {
			if (runtime.ctx.mode === "tui" && typeof runtime.ctx.ui.custom === "function") {
				const customResult = await runtime.ctx.ui.custom<AskInteractionResult>(
					(tui, theme, _keybindings, done) => {
						const component = createAskComponent({
							questionnaire,
							host: {
								requestRender: () => tui.requestRender(),
								getTerminalRows: () => tui.terminal.rows,
							},
							theme,
							signal: abort.signal,
							done,
						});
						current.component = component;
						return component;
					},
				);
				if (!customResult) throw new Error("Ask UI closed without a result");
				return customResult;
			}
			if (hasDialogUI(runtime.ctx.ui))
				return runAskFallback(questionnaire, runtime.ctx.ui, abort.signal);
			throw new Error("Ask requires interactive UI");
		} finally {
			if (signal) signal.removeEventListener("abort", onAbort);
			current.component?.dispose();
			if (activeAsk === current) activeAsk = undefined;
		}
	};

	pi.registerTool({
		name: ASK_TOOL_NAME,
		label: ASK_TOOL_LABEL,
		description: ASK_TOOL_DESCRIPTION,
		promptSnippet: ASK_PROMPT_SNIPPET,
		promptGuidelines: [...ASK_PROMPT_GUIDELINES],
		parameters: ASK_PARAMETERS,
		prepareArguments: (value): Static<typeof ASK_PARAMETERS> =>
			normalizeAskParams(value) as Static<typeof ASK_PARAMETERS>,
		executionMode: "sequential",
		renderCall: (args, theme) =>
			textComponent(
				theme.fg(
					"accent",
					`? Ask (${args.questions.length} question${args.questions.length === 1 ? "" : "s"})`,
				),
			),
		renderResult: (result, _options, theme, context) =>
			textComponent(theme.fg(context.isError ? "error" : "success", resultText(result))),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const runtime = activeRuntime;
			if (
				!runtime ||
				runtime.ctx.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()
			)
				throw new Error("Ask runtime is not active");
			onUpdate?.({
				content: [{ type: "text", text: "Waiting for user input..." }],
				details: undefined,
			});
			const result = await requestAsk(normalizeAskParams(params), signal);
			return {
				content: [{ type: "text", text: formatAskResult(result.details) }],
				details: result.details,
			};
		},
	});

	return {
		start(runtime) {
			activeRuntime = runtime;
			const interactive =
				(runtime.ctx.mode === "tui" && typeof runtime.ctx.ui.custom === "function") ||
				hasDialogUI(runtime.ctx.ui);
			coordinator.setAskVisible(interactive);
		},
		requestAsk,
		async dispose(sessionId) {
			if (activeRuntime?.ctx.sessionManager.getSessionId() !== sessionId) return;
			activeAsk?.abort.abort(new Error("Ask session ended"));
			activeAsk?.component?.dispose();
			activeAsk = undefined;
			coordinator.setAskVisible(false);
			activeRuntime = undefined;
		},
	};
}
