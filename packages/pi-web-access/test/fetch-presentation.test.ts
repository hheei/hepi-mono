import { describe, expect, test } from "vitest";
import type { ExtractedContent } from "../src/extract.ts";
import { resolveFetchRequest } from "../src/fetch-params.ts";
import {
	type FetchPresentation,
	presentFetchedUrls,
	presentSingleFetch,
} from "../src/web-tool-core.ts";

// fetch_content is split into resolveFetchRequest (parameter compatibility),
// the orchestrated fetch/answer/store steps, and the pure presenters below.
// These tests pin the parameter rules and the presentation contracts.

const modeConfig = {
	defaultMode: "readable",
	allowedModes: ["readable", "raw", "answer"],
} as const;

describe("resolveFetchRequest", () => {
	test("applies the configured default mode and normalizes the URL list", () => {
		const request = resolveFetchRequest(
			{ urls: [" https://a.test ", "https://a.test", "https://b.test"] },
			modeConfig,
		);

		expect(request.urlList).toEqual(["https://a.test", "https://b.test"]);
		expect(request.mode).toBe("readable");
	});

	test("keeps an explicitly allowed mode", () => {
		const request = resolveFetchRequest({ url: "https://a.test", mode: "raw" }, modeConfig);

		expect(request.mode).toBe("raw");
	});

	test.each([
		{
			params: { url: "https://a.test", mode: "raw" },
			allowedModes: ["readable", "answer"] as const,
			error: 'Fetch mode "raw" is disabled by fetch.allowedModes.',
		},
		{
			params: { url: "https://a.test", mode: "answer" },
			error: "mode answer requires prompt.",
		},
		{
			params: { url: "https://a.test", mode: "raw", prompt: "why" },
			error:
				"mode raw cannot be combined with forceClone, prompt, timestamp, frames, model, or answerModel.",
		},
		{
			params: { url: "https://a.test", answerModel: "small" },
			error: "answerModel requires mode answer.",
		},
		{
			params: { url: "https://a.test", mode: "answer", prompt: "why", model: "small" },
			error: "use answerModel, not model, with mode answer.",
		},
		{
			params: { url: "https://a.test", mode: "answer", prompt: "why", auth: true },
			error: "auth cannot be combined with mode answer.",
		},
		{
			params: {},
			error: "No URL provided. Use the 'url' parameter, or 'urls' for parallel fetches.",
		},
		{
			params: { url: "https://a.test", mode: "sideways" },
			error: 'mode must be "readable", "raw", or "answer"',
		},
	])("rejects $params", ({ params, error, allowedModes }) => {
		expect(() =>
			resolveFetchRequest(params, {
				defaultMode: "readable",
				allowedModes: allowedModes ? [...allowedModes] : [...modeConfig.allowedModes],
			}),
		).toThrow(error);
	});
});

const page = (overrides: Partial<ExtractedContent> = {}): ExtractedContent => ({
	url: "https://a.test",
	title: "A page",
	content: "abcdefghij",
	error: null,
	...overrides,
});

function presentation(overrides: Partial<FetchPresentation> = {}): FetchPresentation {
	const urls = ["https://a.test"];
	return {
		mode: "readable",
		getSearchContentTool: "get_search_content",
		responseId: "fetch-1",
		maxChars: 5,
		urlList: urls,
		structuredContent: { responseId: "fetch-1", urls: [] },
		...overrides,
	};
}

describe("presentSingleFetch", () => {
	test("truncates to the budget and points at the next slice", () => {
		const result = presentSingleFetch(presentation(), page(), {});

		expect(result.content).toEqual([
			{
				type: "text",
				text: 'abcde\n\n---\nShowing 5 of 10 chars, 5 of 10 bytes, and 1 of 1 lines. Use get_search_content({ responseId: "fetch-1", urlIndex: 0, offset: 5 }) for the next slice.',
			},
		]);
		expect(result.details).toMatchObject({ responseId: "fetch-1", truncated: true, urlCount: 1 });
	});

	test("sends an answer-mode reader back to the stored original source", () => {
		const result = presentSingleFetch(presentation({ mode: "answer" }), page(), {
			prompt: "why",
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: 'abcde\n\n---\nShowing 5 of 10 chars, 5 of 10 bytes, and 1 of 1 lines. Stored content is the original source, not the remaining answer. Use get_search_content({ responseId: "fetch-1", urlIndex: 0, offset: 0 }) to read the original source from the beginning.',
			},
		]);
		expect(result.details).toMatchObject({ mode: "answer", prompt: "why" });
	});

	test("announces full stored content after an untruncated page", () => {
		const result = presentSingleFetch(presentation({ maxChars: 10 }), page(), {});

		expect(result.content).toEqual([
			{ type: "text", text: "abcdefghij" },
			{
				type: "text",
				text: '\n---\nFull content is stored as responseId "fetch-1". Use get_search_content({ responseId: "fetch-1", urlIndex: 0, offset: 0 }) to retrieve it.',
			},
		]);
		expect(result.details).toMatchObject({ truncated: false });
	});

	test.each([
		{
			context: { responseId: null },
			hint: "Authenticated fetch cache is off; repeat the fetch to read more.",
		},
		{
			context: { getSearchContentTool: null },
			hint: "Content retrieval is not registered.",
		},
	])("explains why the next slice is unavailable: $hint", ({ context, hint }) => {
		const result = presentSingleFetch(presentation(context), page(), {});

		expect(result.content).toEqual([
			{
				type: "text",
				text: `abcde\n\n---\nShowing 5 of 10 chars, 5 of 10 bytes, and 1 of 1 lines. ${hint}`,
			},
		]);
	});

	test("shows video frames before the page text", () => {
		const result = presentSingleFetch(
			presentation({ maxChars: 10 }),
			page({ frames: [{ data: "AA", mimeType: "image/jpeg", timestamp: "0:01" }] }),
			{ frames: 2 },
		);

		expect(result.content).toEqual([
			{ type: "image", data: "AA", mimeType: "image/jpeg" },
			{ type: "text", text: "Frame at 0:01" },
			{ type: "text", text: "abcdefghij" },
			{
				type: "text",
				text: '\n---\nFull content is stored as responseId "fetch-1". Use get_search_content({ responseId: "fetch-1", urlIndex: 0, offset: 0 }) to retrieve it.',
			},
		]);
		expect(result.details).toMatchObject({ hasImage: true, imageCount: 1, frames: 2 });
	});

	test("reports a failed fetch as an error result", () => {
		const result = presentSingleFetch(presentation(), page({ content: "", error: "blocked" }), {});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Error: blocked" }]);
		expect(result.details).toMatchObject({ successful: 0, error: "blocked" });
	});

	test("reports a missing result", () => {
		const result = presentSingleFetch(presentation(), undefined, {});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Error: No result found" }]);
	});
});

describe("presentFetchedUrls", () => {
	test("summarizes each URL and points at the stored content", () => {
		const result = presentFetchedUrls(presentation({ maxChars: 10 }), [
			page(),
			page({ url: "https://b.test", title: "", content: "", error: "blocked" }),
		]);

		expect(result.content).toEqual([
			{
				type: "text",
				text: '## Fetched URLs\n\n- A page (10 chars)\n- https://b.test: Error - blocked\n\n---\nUse get_search_content({ responseId: "fetch-1", urlIndex: 0 }) to retrieve bounded content slices.',
			},
		]);
		expect(result.details).toEqual({
			urls: ["https://a.test"],
			urlCount: 1,
			successful: 1,
			totalChars: 10,
			responseId: "fetch-1",
		});
	});

	test("shares the output budget across answers and marks what was cut", () => {
		const result = presentFetchedUrls(presentation({ mode: "answer", maxChars: 20 }), [
			page({ content: "first-answer" }),
			page({ url: "https://b.test", content: "second-answer" }),
		]);

		expect(result.content).toEqual([
			{
				type: "text",
				text: '## Page answers\n\n### A page\nfirst-answer\n\n### A page\nsecond-a\n[answer truncated at the output limit; fetch fewer URLs per call for complete answers]\n\n---\nStored content is the original source pages, not the answers. Use get_search_content({ responseId: "fetch-1", urlIndex: 0, offset: 0 }) to read the first source; urlIndex follows the order above.',
			},
		]);
	});

	test("marks the call as failed when nothing succeeded", () => {
		const result = presentFetchedUrls(presentation(), [page({ content: "", error: "blocked" })]);

		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ successful: 0 });
	});

	test("explains why stored content is unavailable", () => {
		const unstored = presentFetchedUrls(presentation({ responseId: null }), [page()]);

		expect(unstored.content).toEqual([
			{
				type: "text",
				text: "## Fetched URLs\n\n- A page (10 chars)\n\n---\nAuthenticated fetch cache is off; repeat the fetch to read content.",
			},
		]);
		expect(unstored.details).not.toHaveProperty("responseId");
	});
});
