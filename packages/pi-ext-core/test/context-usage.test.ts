import { expect, test } from "vitest";
import {
	estimatePiPrefixTokens,
	estimateTextTokens,
	resolvePiContextUsage,
} from "../src/context-usage.js";

test("estimates prefix from system prompt and tool schemas", () => {
	const systemPrompt = "You are pi.\n<available_skills>\nskill\n</available_skills>";
	const tools = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	];
	const out = estimatePiPrefixTokens({ systemPrompt, tools });
	expect(out.systemPromptTokens).toBe(estimateTextTokens(systemPrompt));
	expect(out.toolDefinitionTokens).toBeGreaterThan(0);
	expect(out.tokens).toBe(out.systemPromptTokens + out.toolDefinitionTokens);
});

test("uses a caller tokenizer when provided", () => {
	const out = estimatePiPrefixTokens({
		systemPrompt: "abcd",
		estimateTokens: (text) => text.length,
	});
	expect(out.systemPromptTokens).toBe(4);
	expect(out.tokens).toBe(4);
});

test("does not tokenize a prefix when live tokens are already positive", () => {
	let called = 0;
	resolvePiContextUsage({
		live: { tokens: 10, percent: 1, contextWindow: 80_000 },
		systemPrompt: "You are pi.",
		estimateTokens: () => {
			called += 1;
			return 4;
		},
	});
	expect(called).toBe(0);
});

test("keeps live tokens when Pi already has a usage reading", () => {
	const resolved = resolvePiContextUsage({
		live: { tokens: 12_000, percent: 15, contextWindow: 80_000 },
		prefixTokens: 4_000,
	});
	expect(resolved).toMatchObject({
		tokens: 12_000,
		percent: 15,
		source: "live",
	});
});

test("floors a new session at prefix tokens", () => {
	const resolved = resolvePiContextUsage({
		live: { tokens: 0, percent: 0, contextWindow: 80_000 },
		systemPrompt: "You are pi.",
		tools: [{ name: "read", description: "Read a file" }],
	});
	expect(resolved.source).toBe("prefix");
	expect(resolved.tokens).toBeGreaterThan(0);
	expect(resolved.percent).toBeGreaterThan(0);
	expect(resolved.prefix.systemPromptTokens).toBeGreaterThan(0);
});

test("uses explicit prefixTokens as the new-session floor", () => {
	const resolved = resolvePiContextUsage({
		live: { tokens: 0, percent: 0, contextWindow: 100_000 },
		prefixTokens: 3_500,
	});
	expect(resolved.tokens).toBe(3_500);
	expect(resolved.source).toBe("prefix");
	expect(resolved.percent).toBeCloseTo(3.5);
});

test("treats compaction null as unknown instead of prefix", () => {
	const resolved = resolvePiContextUsage({
		live: { tokens: null, percent: null, contextWindow: 80_000 },
		prefixTokens: 4_000,
	});
	expect(resolved).toMatchObject({
		tokens: undefined,
		percent: undefined,
		source: "unknown",
	});
});

test("treats missing live usage as unknown", () => {
	const resolved = resolvePiContextUsage({ prefixTokens: 4_000 });
	expect(resolved.source).toBe("unknown");
	expect(resolved.tokens).toBeUndefined();
});
