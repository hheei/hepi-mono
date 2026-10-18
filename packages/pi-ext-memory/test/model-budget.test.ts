import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../src/model-budget.js";

describe("boundedMaxTokens", () => {
	it.each([
		{
			label: "defaults the requested budget when the model has no positive maxTokens",
			maxTokens: undefined,
			requested: undefined,
			expected: AGENT_LOOP_MAX_TOKENS,
		},
		{
			label: "uses the requested budget when the model maxTokens is larger",
			maxTokens: 64_000,
			requested: 8_192,
			expected: 8_192,
		},
		{
			label: "clamps the requested budget down to the model maxTokens",
			maxTokens: 8_192,
			requested: AGENT_LOOP_MAX_TOKENS,
			expected: 8_192,
		},
		{
			label: "clamps a budget above both the default and the model maxTokens",
			maxTokens: 8_192,
			requested: 64_000,
			expected: 8_192,
		},
		{
			label: "ignores a zero model maxTokens",
			maxTokens: 0,
			requested: 8_192,
			expected: 8_192,
		},
		{
			label: "ignores a negative model maxTokens",
			maxTokens: -1,
			requested: 8_192,
			expected: 8_192,
		},
	])("$label", ({ maxTokens, requested, expected }) => {
		const model = { maxTokens } as Model<Api>;
		const actual =
			requested === undefined ? boundedMaxTokens(model) : boundedMaxTokens(model, requested);
		expect(actual).toBe(expected);
	});
});
