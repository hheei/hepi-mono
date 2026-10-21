import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { findModelWithProviderRouting, isModelInScope } from "./summary-model-scope.ts";
import type { SummaryGenerationContext } from "./summary-review.ts";

async function resolveFirstAvailableModel(
	ctx: SummaryGenerationContext,
	candidates: Array<{ provider: string; id: string }>,
): Promise<Model<Api>> {
	for (const { provider, id } of candidates) {
		const model = findModelWithProviderRouting(ctx.modelRegistry, provider, id);
		if (!model || !isModelInScope(model, ctx.scopedModels)) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) return model;
	}
	throw new Error(
		`No enabled model available: ${candidates.map((candidate) => `${candidate.provider}/${candidate.id}`).join(", ")}`,
	);
}

export async function rewriteSearchQuery(
	query: string,
	ctx: SummaryGenerationContext,
	signal: AbortSignal,
): Promise<string> {
	const model = await resolveFirstAvailableModel(ctx, [
		{ provider: "anthropic", id: "claude-haiku-4-5" },
		{ provider: "google", id: "gemini-3.6-flash" },
		{ provider: "openai", id: "gpt-5-mini" },
	]);
	if (signal.aborted) throw new Error("Aborted");
	const context = {
		messages: [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `Rewrite this web search query to get better, more specific results. Add relevant year qualifiers, precise technical terms, and specificity. Return ONLY the improved query text, nothing else.\n\nQuery: ${query}`,
					},
				],
				timestamp: Date.now(),
			},
		],
	};
	const response = await ctx.modelRegistry.streamSimple(model, context, { signal }).result();
	if (response.stopReason === "aborted") throw new Error("Aborted");
	const contentParts = Array.isArray(response.content) ? response.content : [];
	const text = contentParts
		.map((part: unknown) =>
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("")
		.trim();
	if (!text) throw new Error("Rewrite returned empty response");
	return text;
}
