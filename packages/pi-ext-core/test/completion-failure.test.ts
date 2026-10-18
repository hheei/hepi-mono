import { expect, test } from "vitest";
import { classifyCompletionFailure } from "../src/completion-failure.js";

test.each([
	{
		label: "treats HTTP 429 as transient",
		error: { status: 429 },
		message: "rate limited",
		expected: { kind: "transient", message: "rate limited", status: 429 },
	},
	{
		label: "treats ETIMEDOUT as transient",
		error: { cause: { code: "ETIMEDOUT" } },
		message: "timed out",
		expected: { kind: "transient", message: "timed out", code: "ETIMEDOUT" },
	},
	{
		label: "treats HTTP 400 as an invalid request",
		error: { statusCode: 400 },
		message: "bad request",
		expected: { kind: "invalid-request", message: "bad request", status: 400 },
	},
	{
		label: "does not trust prose that merely mentions failure",
		error: new Error("auth maybe failed"),
		message: "auth maybe failed",
		expected: { kind: "unknown", message: "auth maybe failed" },
	},
])("$label", ({ error, message, expected }) => {
	expect(classifyCompletionFailure(error, message)).toEqual(expected);
});
