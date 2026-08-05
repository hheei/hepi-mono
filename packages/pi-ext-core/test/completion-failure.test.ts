import { expect, test } from "bun:test";
import { classifyCompletionFailure } from "../src/completion-failure.js";

test("classifies only trusted HTTP and transport evidence", (): void => {
	expect(classifyCompletionFailure({ status: 429 }, "rate limited")).toEqual({
		kind: "transient",
		message: "rate limited",
		status: 429,
	});
	expect(classifyCompletionFailure({ cause: { code: "ETIMEDOUT" } }, "timed out")).toEqual({
		kind: "transient",
		message: "timed out",
		code: "ETIMEDOUT",
	});
	expect(classifyCompletionFailure({ statusCode: 400 }, "bad request")).toEqual({
		kind: "invalid-request",
		message: "bad request",
		status: 400,
	});
	expect(classifyCompletionFailure(new Error("auth maybe failed"), "auth maybe failed")).toEqual({
		kind: "unknown",
		message: "auth maybe failed",
	});
});
