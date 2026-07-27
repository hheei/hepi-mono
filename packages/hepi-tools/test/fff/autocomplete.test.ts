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
						item: { relativePath: "packages/hepi-tools/src/fff/index.ts", fileName: "index.ts" },
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
					value: "@packages/hepi-tools/src/fff/index.ts",
					label: "index.ts",
					description: "packages/hepi-tools/src/fff/index.ts · prefix",
				},
			],
		});
		expect(queries).toEqual(["fff"]);
	});

	test("delegates when the FFF autocomplete feature is disabled", async () => {
		const provider = createFffAutocompleteProvider(
			baseProvider,
			() => undefined,
			() => false,
		);

		await expect(
			provider.getSuggestions(["@ignored"], 0, 8, { signal: new AbortController().signal }),
		).resolves.toEqual({ prefix: "$", items: [{ value: "$skill", label: "$skill" }] });
	});
});
