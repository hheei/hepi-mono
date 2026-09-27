import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * A complete `Model<Api>` for tests.
 *
 * Pi's registry and `ExtensionContext` carry real models, and the memory runtime types its
 * contexts against them, so a test that only cares about `provider`/`id` still has to hand
 * over the rest of the shape. Defaults are inert; whatever the caller passes wins.
 */
export function testModel(
	fields: Pick<Model<Api>, "provider" | "id"> & Partial<Model<Api>>,
): Model<Api> {
	return {
		name: fields.id,
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...fields,
	};
}
