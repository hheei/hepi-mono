import { expect, test } from "bun:test";
import {
	createAssistantMessage,
	createControlledStream,
	createScriptedStream,
	createTestModel,
} from "../src/testing.js";

test("creates deterministic model and terminal assistant fixtures", () => {
	const model = createTestModel({ provider: "fixture", id: "one", contextWindow: 123 });
	const message = createAssistantMessage({
		model,
		text: "answer",
		input: 2,
		output: 3,
		totalTokens: 5,
		cost: 0.25,
	});
	expect(model).toMatchObject({ provider: "fixture", id: "one", contextWindow: 123 });
	expect(message).toMatchObject({
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		usage: { input: 2, output: 3, totalTokens: 5, cost: { total: 0.25 } },
	});
});

test("scripts terminal model responses in order", () => {
	const first = createAssistantMessage({ text: "first" });
	const second = createAssistantMessage({ text: "second" });
	const scripted = createScriptedStream([first, second]);
	const firstStream = scripted.streamFn({} as never, {} as never, {} as never);
	const secondStream = scripted.streamFn({} as never, {} as never, {} as never);
	expect(firstStream).toBeDefined();
	expect(secondStream).toBeDefined();
	expect(scripted.calls()).toBe(2);
});

test("creates a controlled stream for timeout and abort fixtures", () => {
	const controlled = createControlledStream();
	const stream = controlled.streamFn({} as never, {} as never, {} as never);
	controlled.resolve(createAssistantMessage({ text: "done" }));
	expect(stream).toBeDefined();
	expect(controlled.calls()).toBe(1);
});
