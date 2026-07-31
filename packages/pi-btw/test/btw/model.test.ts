import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	BTW_MAX_QUESTION_CHARACTERS,
	buildBtwMessages,
	createBtwTurn,
	extractAssistantText,
	normalizeBtwQuestion,
	serializeMainMessage,
} from "../../model.js";

const message = (value: Message): Message => value;
const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "test",
	provider: "test",
	model: "test",
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
});

function textOf(item: Message): string {
	return typeof item.content === "string"
		? item.content
		: item.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("BTW model", () => {
	test("normalizes whitespace, CR, controls, blanks, and maximum length", () => {
		expect(normalizeBtwQuestion("  one\r\ntwo\r\u0000\u0007  ")).toBe("one\ntwo");
		expect(normalizeBtwQuestion(" \t\n ")).toBe("");
		expect(() => normalizeBtwQuestion("x".repeat(BTW_MAX_QUESTION_CHARACTERS + 1))).toThrow();
	});

	test("serializes ordinary, tool, image, and tool-call messages", () => {
		const user = message({
			role: "user",
			content: [{ type: "text", text: "question" }],
			timestamp: 1,
		});
		const assistantMessage = message({
			role: "assistant",
			content: [
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "1", name: "read", arguments: { path: "x" } },
			],
			api: "test",
			provider: "test",
			model: "test",
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
		});
		const result = message({
			role: "toolResult",
			toolCallId: "1",
			toolName: "read",
			content: [
				{ type: "text", text: "result" },
				{ type: "image", data: "abc", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 1,
		});
		expect(serializeMainMessage(user)).toContain("User:\nquestion");
		expect(serializeMainMessage(assistantMessage)).toContain("[tool call: read");
		expect(serializeMainMessage(result)).toContain(
			"Tool result (read):\nresult\n[image omitted: image/png]",
		);
	});

	test("keeps main context, successful turns, then the current question", () => {
		const turn = createBtwTurn("old question", assistant("old answer"), 2);
		const messages = buildBtwMessages({
			mainMessages: [message({ role: "user", content: "main user", timestamp: 1 })],
			turns: [turn],
			question: "current",
			now: 3,
		});
		expect(messages.map(textOf).join("\n")).toContain("main user");
		expect(messages.map(textOf).join("\n")).toContain("old question");
		expect(messages.at(-1) && textOf(messages.at(-1)!)).toContain("current");
	});

	test("drops oldest main before side history, then drops oldest side history", () => {
		const sideOld = createBtwTurn("side-old", assistant("answer-old ".repeat(8).trim()));
		const sideNew = createBtwTurn("side-new", assistant("answer-new"));
		const mainOld = message({ role: "user", content: "main-old", timestamp: 1 });
		const mainNew = message({ role: "user", content: "main-new", timestamp: 2 });
		const question = "keep me";
		const turnSize = (turn: typeof sideOld): number =>
			textOf(turn.user).length + extractAssistantText(turn.assistant).length;
		const mainNewSize = serializeMainMessage(mainNew).length;
		const bothSideBudget = question.length + turnSize(sideOld) + turnSize(sideNew) + mainNewSize;
		const newestSideBudget = question.length + turnSize(sideNew) + mainNewSize;

		const allSideMessages = buildBtwMessages({
			mainMessages: [mainOld, mainNew],
			turns: [sideOld, sideNew],
			question,
			characterBudget: bothSideBudget,
		});
		const allSide = allSideMessages.map(textOf).join("\n");
		expect(allSide).toContain("keep me");
		expect(allSide).toContain("main-new");
		expect(allSide).toContain("side-old");
		expect(allSide).toContain("side-new");
		expect(allSide).not.toContain("main-old");

		const newestSideMessages = buildBtwMessages({
			mainMessages: [mainOld, mainNew],
			turns: [sideOld, sideNew],
			question,
			characterBudget: newestSideBudget,
		});
		const newestSide = newestSideMessages.map(textOf).join("\n");
		expect(newestSide).toContain("keep me");
		expect(newestSide).toContain("main-new");
		expect(newestSide).toContain("side-new");
		expect(newestSide).not.toContain("main-old");
		expect(newestSide).not.toContain("side-old");
	});

	test("extracts only assistant text parts and creates a turn", () => {
		const response = assistant(" first ");
		response.content = [
			{ type: "thinking", thinking: "hidden" },
			{ type: "text", text: " first " },
			{ type: "text", text: "second" },
		];
		expect(extractAssistantText(response)).toBe("first \nsecond");
		expect(createBtwTurn(" q ", response, 9).user).toEqual({
			role: "user",
			content: [{ type: "text", text: "q" }],
			timestamp: 9,
		});
	});
});
