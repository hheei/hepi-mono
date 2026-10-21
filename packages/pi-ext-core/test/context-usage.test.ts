import { expect, test } from "vitest";
import { estimateEntryTokens, estimateTextTokens } from "../src/context-usage.js";

test("estimates text tokens by character length fallback", () => {
	expect(estimateTextTokens("")).toBe(0);
	expect(estimateTextTokens("abcd")).toBe(1);
	expect(estimateTextTokens("abcde")).toBe(2);
});

test("estimates entry tokens for message, custom_message, and branch_summary", () => {
	expect(
		estimateEntryTokens({
			type: "message",
			message: { role: "user", content: "hello world" },
		}),
	).toBeGreaterThan(0);

	expect(
		estimateEntryTokens({
			type: "custom_message",
			content: "custom text content",
		}),
	).toBe(Math.ceil("custom text content".length / 4));

	expect(
		estimateEntryTokens({
			type: "branch_summary",
			summary: "summary text",
		}),
	).toBe(Math.ceil("summary text".length / 4));
});
