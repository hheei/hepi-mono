import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { stripMctxTagPrefix } from "../src/tag-prefix.js";

test("strips one model-imitated MCTX tag from assistant text", (): void => {
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "§42§ answer" },
			{ type: "text", text: "§43§ preserved later content" },
		],
		timestamp: 0,
	};
	expect(stripMctxTagPrefix(message)).toMatchObject({
		content: [
			{ type: "text", text: "answer" },
			{ type: "text", text: "§43§ preserved later content" },
		],
	});
});

test("preserves an assistant message without a tag prefix", (): void => {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		timestamp: 0,
	};
	expect(stripMctxTagPrefix(message)).toBe(message);
});
