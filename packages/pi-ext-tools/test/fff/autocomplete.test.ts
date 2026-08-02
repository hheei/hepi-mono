import { describe, expect, test } from "bun:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { Result } from "better-result";
import { createFffAutocompleteProvider } from "../../src/fff/autocomplete.js";

const baseProvider: AutocompleteProvider = {
	async getSuggestions() {
		return { prefix: "$", items: [{ value: "$skill", label: "$skill" }] };
	},
	applyCompletion(lines, cursorLine, cursorCol) {
		return { lines, cursorLine, cursorCol };
	},
};

describe("HEPI FFF autocomplete", () => {
	test("delegates non-path completion to the preceding provider", async () => {
		const provider = createFffAutocompleteProvider(
			baseProvider,
			() => undefined,
			() => true,
		);

		await expect(
			provider.getSuggestions(["$skill"], 0, 6, { signal: new AbortController().signal }),
		).resolves.toEqual({ prefix: "$", items: [{ value: "$skill", label: "$skill" }] });
	});

	test("uses FFF only for @ path completion", async () => {
		const queries: string[] = [];
		const runtime = {
			searchFileCandidates: async (query: string) => {
				queries.push(query);
				return Result.ok([
					{
						item: {
							relativePath: "packages/pi-ext-tools/src/extension.ts",
							fileName: "extension.ts",
						},
						score: { matchType: "prefix" },
					},
				]);
			},
			trackQuery: async () => Result.ok(undefined),
		} as never;
		const provider = createFffAutocompleteProvider(
			baseProvider,
			() => runtime,
			() => true,
		);

		await expect(
			provider.getSuggestions(["@fff"], 0, 4, { signal: new AbortController().signal }),
		).resolves.toEqual({
			prefix: "@fff",
			items: [
				{
					value: "@packages/pi-ext-tools/src/extension.ts",
					label: "extension.ts",
					description: "packages/pi-ext-tools/src/extension.ts · prefix",
				},
			],
		});
		expect(queries).toEqual(["fff"]);
	});
});
