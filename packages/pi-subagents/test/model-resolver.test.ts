import { describe, expect, it } from "vitest";
import { type ModelEntry, type ModelRegistry, resolveModel } from "../src/model-resolver.js";

const MODELS = [
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
	{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
] as const satisfies readonly ModelEntry[];

function registry(available: readonly ModelEntry[] = MODELS): ModelRegistry {
	return {
		find: (provider, modelId) =>
			available.find((model) => model.provider === provider && model.id === modelId),
		getAll: () => MODELS,
		getAvailable: () => available,
	};
}

describe("resolveModel", () => {
	it("resolves an exact authenticated provider/modelId", () => {
		expect(resolveModel("anthropic/claude-opus-4-6", registry())).toEqual(MODELS[0]);
	});

	it("rejects an unqualified model name", () => {
		expect(resolveModel("opus", registry())).toBe('Model must use provider/modelId: "opus"');
	});

	it("does not substitute another provider", () => {
		expect(resolveModel("anthropic/gpt-4o", registry())).toContain(
			'Model not found: "anthropic/gpt-4o"',
		);
	});

	it("rejects models without configured auth", () => {
		expect(resolveModel("openai/gpt-4o", registry([MODELS[0]]))).toContain(
			'Model not found: "openai/gpt-4o"',
		);
	});
});
