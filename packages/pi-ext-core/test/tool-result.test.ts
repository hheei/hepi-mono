import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { agentResultText, formatDuration, textToolResult } from "../src/index.js";

function result(content: AgentToolResult<unknown>["content"]): AgentToolResult<unknown> {
	return { content, details: undefined };
}

describe("agentResultText", () => {
	test("reads a single text part without copying the array", () => {
		expect(agentResultText(result([{ type: "text", text: "one" }]))).toBe("one");
	});

	test("joins several text parts with a newline", () => {
		expect(
			agentResultText(
				result([
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				]),
			),
		).toBe("one\ntwo");
	});

	test("keeps the text parts of a mixed result and drops images", () => {
		expect(
			agentResultText(
				result([
					{ type: "image", data: "aGk=", mimeType: "image/png" },
					{ type: "text", text: "caption" },
				]),
			),
		).toBe("caption");
	});

	test("returns an empty string when the result carries no text", () => {
		expect(agentResultText(result([{ type: "image", data: "aGk=", mimeType: "image/png" }]))).toBe(
			"",
		);
		expect(agentResultText(result([]))).toBe("");
	});
});

describe("formatDuration", () => {
	test("omits an unmeasured duration", () => {
		expect(formatDuration(undefined)).toBeUndefined();
		expect(formatDuration(Number.NaN)).toBeUndefined();
	});

	test("shows milliseconds below one second and seconds above it", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(940)).toBe("940ms");
		expect(formatDuration(999.4)).toBe("999ms");
		expect(formatDuration(1_000)).toBe("1.0s");
		expect(formatDuration(12_340)).toBe("12.3s");
	});

	test("clamps a negative measurement to zero", () => {
		expect(formatDuration(-5)).toBe("0ms");
	});
});

describe("textToolResult", () => {
	test("builds the single-text-part shape every tool returns", () => {
		expect(textToolResult("hello", { a: 1 })).toEqual({
			content: [{ type: "text", text: "hello" }],
			details: { a: 1 },
		});
	});

	test("keeps details undefined when a tool has none", () => {
		expect(textToolResult("hello", undefined)).toEqual({
			content: [{ type: "text", text: "hello" }],
			details: undefined,
		});
	});

	test("round-trips through agentResultText", () => {
		expect(agentResultText(textToolResult("hello", undefined))).toBe("hello");
	});
});
