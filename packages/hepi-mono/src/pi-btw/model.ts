import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { buildMainContextPrompt, buildSideQuestionPrompt } from "./prompt.js";

export const BTW_CONTEXT_CHARACTER_BUDGET = 60_000;
export const BTW_MAX_QUESTION_CHARACTERS = 4_000;

export interface BtwTurn {
	readonly user: UserMessage;
	readonly assistant: AssistantMessage;
}

export interface BtwRequestToken {
	readonly sessionId: string;
	readonly runtimeRevision: number;
	readonly contextRevision: number;
	readonly historyGeneration: number;
	readonly requestRevision: number;
}

export interface BuildBtwMessagesOptions {
	readonly mainMessages: readonly Message[];
	readonly turns: readonly BtwTurn[];
	readonly question: string;
	readonly now?: number;
	readonly characterBudget?: number;
}

interface BudgetedContext {
	readonly mainContext: string;
	readonly turns: readonly BtwTurn[];
}

function replaceControlCodePoints(value: string): string {
	return [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0);
			if (codePoint === undefined) return "";
			if (
				(codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) ||
				(codePoint >= 0x7f && codePoint <= 0x9f)
			) {
				return " ";
			}
			return character;
		})
		.join("");
}

export function normalizeBtwQuestion(value: string): string {
	const normalized = replaceControlCodePoints(
		value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
	).trim();
	if ([...normalized].length > BTW_MAX_QUESTION_CHARACTERS)
		throw new Error(`BTW question must be at most ${BTW_MAX_QUESTION_CHARACTERS} characters`);
	return normalized;
}

export function extractAssistantText(response: AssistantMessage): string {
	return response.content
		.filter(
			(part): part is { readonly type: "text"; readonly text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function contentPartText(
	part: Message extends { content: infer Content }
		? Content extends readonly (infer Part)[]
			? Part
			: never
		: never,
): string {
	// Pi AI exposes message content through a generic message type, while the runtime values are discriminated.
	switch (part.type) {
		// biome-ignore lint/suspicious/noUnnecessaryConditions: Pi AI exposes this discriminated union through a generic message type.
		case "text":
			return part.text;
		// biome-ignore lint/suspicious/noUnnecessaryConditions: Pi AI exposes this discriminated union through a generic message type.
		case "image":
			return `[image omitted: ${part.mimeType}]`;
		// biome-ignore lint/suspicious/noUnnecessaryConditions: Pi AI exposes this discriminated union through a generic message type.
		case "thinking":
			return "";
		// biome-ignore lint/suspicious/noUnnecessaryConditions: Pi AI exposes this discriminated union through a generic message type.
		case "toolCall":
			return `[tool call: ${part.name} ${safeJson(part.arguments)}]`;
		default:
			return part satisfies never;
	}
}

function contentText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map(contentPartText)
		.filter((part) => part.length > 0)
		.join("\n");
}

function serializeMessageByRole(message: Message, body: string): string {
	// Pi AI exposes message roles through a generic message type, while the runtime values are discriminated.
	switch (message.role) {
		// biome-ignore lint/suspicious/noUnnecessaryConditions: Pi AI exposes this discriminated union through a generic message type.
		case "user":
			return `User:\n${body}`;
		// biome-ignore lint/suspicious/noUnnecessaryConditions: Pi AI exposes this discriminated union through a generic message type.
		case "assistant":
			return `Assistant:\n${body}`;
		// biome-ignore lint/suspicious/noUnnecessaryConditions: Pi AI exposes this discriminated union through a generic message type.
		case "toolResult":
			return `Tool result (${message.toolName}):\n${body}`;
		default:
			return message satisfies never;
	}
}

export function serializeMainMessage(message: Message): string {
	return serializeMessageByRole(message, contentText(message));
}

function turnSize(turn: BtwTurn): number {
	return contentText(turn.user).length + extractAssistantText(turn.assistant).length;
}

function budgetContext(
	mainMessages: readonly Message[],
	turns: readonly BtwTurn[],
	question: string,
	budget: number,
): BudgetedContext {
	let remaining = Math.max(0, Math.floor(budget) - question.length);
	const keptTurns: BtwTurn[] = [];
	for (let index = turns.length - 1; index >= 0; index--) {
		const turn = turns[index];
		if (turn === undefined) continue;
		const size = turnSize(turn);
		if (size > remaining) break;
		keptTurns.unshift(turn);
		remaining -= size;
	}
	const serializedMain = mainMessages.map(serializeMainMessage);
	const keptMain: string[] = [];
	for (let index = serializedMain.length - 1; index >= 0; index--) {
		const message = serializedMain[index];
		if (message === undefined) continue;
		const size = message.length + (keptMain.length > 0 ? 6 : 0);
		if (size > remaining) break;
		keptMain.unshift(message);
		remaining -= size;
	}
	return { mainContext: keptMain.join("\n\n---\n\n"), turns: keptTurns };
}

export function createBtwUserMessage(text: string, timestamp = Date.now()): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

export function buildBtwMessages(options: BuildBtwMessagesOptions): readonly Message[] {
	const question = normalizeBtwQuestion(options.question);
	if (!question) throw new Error("BTW question must not be blank");
	const timestamp = options.now ?? Date.now();
	const budgeted = budgetContext(
		options.mainMessages,
		options.turns,
		question,
		options.characterBudget ?? BTW_CONTEXT_CHARACTER_BUDGET,
	);
	return [
		createBtwUserMessage(buildMainContextPrompt(budgeted.mainContext), timestamp),
		...budgeted.turns.flatMap((turn) => [turn.user, turn.assistant]),
		createBtwUserMessage(buildSideQuestionPrompt(question), timestamp),
	];
}

export function createBtwTurn(
	question: string,
	response: AssistantMessage,
	timestamp = Date.now(),
): BtwTurn {
	return {
		user: createBtwUserMessage(normalizeBtwQuestion(question), timestamp),
		assistant: response,
	};
}
