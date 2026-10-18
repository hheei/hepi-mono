import { describe, expect, it } from "vitest";

import {
	type Config,
	DEFAULTS,
	OBSERVER_CHUNK_CONTEXT_RATIO,
	OBSERVER_CHUNK_FALLBACK_MAX_TOKENS,
	OBSERVER_CHUNK_MIN_TOKENS,
	resolveObserverChunkMaxTokens,
} from "../src/config.js";

function config(overrides: Partial<Config> = {}): Config {
	return { ...DEFAULTS, ...overrides };
}

const derived = (window: number) => Math.floor(window * OBSERVER_CHUNK_CONTEXT_RATIO);

describe("resolveObserverChunkMaxTokens", () => {
	it.each([
		{
			label: "uses an explicit cap even when a context window is present",
			overrides: { observerChunkMaxTokens: 12_345 },
			window: 1_000_000,
			expected: 12_345,
		},
		{
			label: "uses an explicit cap when the context window is missing",
			overrides: { observerChunkMaxTokens: 12_345 },
			window: undefined,
			expected: 12_345,
		},
		{
			label: "derives the cap from a large context window",
			overrides: {},
			window: 1_000_000,
			expected: derived(1_000_000),
		},
		{
			label: "derives the cap from a 200_000 context window",
			overrides: {},
			window: 200_000,
			expected: derived(200_000),
		},
		{
			label: "clamps a derived cap up to the minimum useful chunk",
			overrides: {},
			window: 3,
			expected: OBSERVER_CHUNK_MIN_TOKENS,
		},
		{
			label: "falls back when the context window is missing",
			overrides: {},
			window: undefined,
			expected: OBSERVER_CHUNK_FALLBACK_MAX_TOKENS,
		},
		{
			label: "falls back when the context window is zero",
			overrides: {},
			window: 0,
			expected: OBSERVER_CHUNK_FALLBACK_MAX_TOKENS,
		},
		{
			label: "falls back when the context window is negative",
			overrides: {},
			window: -1,
			expected: OBSERVER_CHUNK_FALLBACK_MAX_TOKENS,
		},
		{
			label: "falls back when the context window is NaN",
			overrides: {},
			window: Number.NaN,
			expected: OBSERVER_CHUNK_FALLBACK_MAX_TOKENS,
		},
		{
			label: "clamps an explicit cap up to the minimum useful chunk",
			overrides: { observerChunkMaxTokens: 1 },
			window: 100_000,
			expected: OBSERVER_CHUNK_MIN_TOKENS,
		},
		{
			label: "ignores a non-positive explicit cap and derives from the window",
			overrides: { observerChunkMaxTokens: 0 },
			window: 100_000,
			expected: derived(100_000),
		},
	] as const)("$label", ({ overrides, window, expected }) => {
		expect(resolveObserverChunkMaxTokens(config(overrides), window)).toBe(expected);
	});
});
