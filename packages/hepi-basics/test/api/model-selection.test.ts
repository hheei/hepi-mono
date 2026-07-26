import { describe, expect, test } from "bun:test";
import {
	createHePiModelSelectionField,
	hePiAuthenticatedModelSelectionOptions,
} from "../../src/core/index.js";

describe("model selection settings", () => {
	test("filters to authenticated available models across providers and formats dynamic thinking", () => {
		const options = hePiAuthenticatedModelSelectionOptions({
			getRegisteredProviderIds: () => [],
			getAvailable: () => [
				{ provider: "cx", id: "gpt-5.6-luna", authenticated: true },
				{ provider: "openai", id: "gpt-5.4", authenticated: true },
				{ provider: "cx", id: "unauthenticated", authenticated: false },
			],
			hasConfiguredAuth: (model) => model.authenticated,
		});
		expect(options).toEqual([
			{ value: "", label: "Not set" },
			{ value: "cx/gpt-5.6-luna", label: "cx/gpt-5.6-luna" },
			{ value: "openai/gpt-5.4", label: "openai/gpt-5.4" },
		]);
		const field = createHePiModelSelectionField({
			id: "model",
			label: "model",
			description: "Select the model used by this shared settings fixture.",
			modelOptions: options,
			thinking: {
				fieldId: "thinking",
				label: "Thinking",
				description: "Select the reasoning intensity used by this shared settings fixture.",
				defaultValue: "medium",
				options: [
					{ value: "low", label: "low" },
					{ value: "medium", label: "medium" },
				],
			},
		});
		expect(field.formatDisplay?.("cx/gpt-5.6-luna", "low")).toBe("◔ cx/gpt-5.6-luna");
		expect(field.formatDescription?.("cx/gpt-5.6-luna", "low")).toBe("cx/gpt-5.6-luna low");
	});

	test("fixes title generation thinking to off without a Tab cycle", () => {
		const field = createHePiModelSelectionField({
			id: "titleModel",
			label: "title model",
			description: "Select the model used to generate automatic session titles.",
			modelOptions: [{ value: "cx/gpt-5.6-luna", label: "cx/gpt-5.6-luna" }],
			thinking: "off",
		});
		expect(field.tabCycle).toBeUndefined();
		expect(field.formatDisplay?.("cx/gpt-5.6-luna")).toBe("○ cx/gpt-5.6-luna");
		expect(field.formatDescription?.("cx/gpt-5.6-luna")).toBe("cx/gpt-5.6-luna off");
	});
});
