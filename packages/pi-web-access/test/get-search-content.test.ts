import { beforeEach, describe, expect, test } from "vitest";
import type { ResearchArtifact } from "../src/source-check.ts";
import { storeResearchArtifact } from "../src/source-check.ts";
import { clearResults, storeResult } from "../src/storage.ts";
import {
	createWebToolCore,
	DEFAULT_TOOL_NAMES,
	type WebToolCoreSettings,
} from "../src/web-tool-core.ts";

// These tests pin get_search_content behavior across the three stored result shapes:
// which content a call selects, how find/paging text is assembled, and the exact
// error text and details each shape reports.
const MAX_CHARS = 200;

const research: ResearchArtifact = {
	id: "res-1",
	type: "research",
	timestamp: 1,
	query: "solar power",
	sources: [{ rank: 1, url: "https://a.test", title: "A", quality: "blog" }],
	passages: [
		{
			passage_id: "p1",
			source_url: "https://a.test",
			source_rank: 1,
			text: "Solar panels convert sunlight.",
		},
	],
};
const serializedResearch = JSON.stringify(research, null, 2);
const collapsedResearch = serializedResearch.replace(/\s+/g, " ").trim();

const fetchedContent = "abcdefghij".repeat(20);

function createCore() {
	const settings: WebToolCoreSettings = {
		toolNames: DEFAULT_TOOL_NAMES,
		enabledTools: {
			webSearch: true,
			sourceCheck: true,
			fetchContent: true,
			getSearchContent: true,
		},
		maxInlineContentChars: MAX_CHARS,
		fetchModes: { defaultMode: "readable", allowedModes: ["readable", "raw", "answer"] },
	};
	return createWebToolCore({ settings, storeFetchedContent() {} });
}

beforeEach(() => {
	clearResults();
	storeResearchArtifact(research);
	storeResult("search-1", {
		id: "search-1",
		type: "search",
		timestamp: 1,
		queries: [
			{
				query: "first",
				answer: "",
				results: [{ title: "One", url: "https://one.test", snippet: "one snippet" }],
				error: null,
			},
			{
				query: "second",
				answer: "",
				results: [{ title: "Two", url: "https://two.test", snippet: "two snippet" }],
				error: null,
			},
			{ query: "broken", answer: "", results: [], error: "provider failed" },
		],
	});
	storeResult("fetch-1", {
		id: "fetch-1",
		type: "fetch",
		timestamp: Date.now(),
		urls: [{ url: "https://one.test", title: "One page", content: fetchedContent, error: null }],
	});
	storeResult("fetch-2", {
		id: "fetch-2",
		type: "fetch",
		timestamp: Date.now(),
		urls: [
			{ url: "https://one.test", title: "One page", content: fetchedContent, error: null },
			{ url: "https://two.test", title: "Two page", content: fetchedContent, error: null },
		],
	});
	storeResult("fetch-3", {
		id: "fetch-3",
		type: "fetch",
		timestamp: Date.now(),
		urls: [{ url: "https://one.test", title: "One page", content: "", error: "fetch failed" }],
	});
	storeResult("invalid-1", { id: "invalid-1", type: "search", timestamp: 1 });
});

describe("get_search_content: research artifact", () => {
	test("pages the serialized artifact and points at the next slice", async () => {
		const result = await createCore().getSearchContent({ responseId: "res-1", limit: 40 });

		expect(result.content).toEqual([
			{
				type: "text",
				text: `${serializedResearch.slice(0, 40)}\n\n---\nShowing chars 0-40 of ${serializedResearch.length}. Use get_search_content({ responseId: "res-1", offset: 40, limit: 40 }) for the next slice.`,
			},
		]);
		expect(result.details).toEqual({
			responseId: "res-1",
			type: "research",
			contentLength: serializedResearch.length,
			offset: 0,
			limit: 40,
			returnedChars: 40,
			nextOffset: 40,
			truncated: true,
		});
	});

	test("keeps the page inside the output ceiling because the next-slice hint counts", async () => {
		const result = await createCore().getSearchContent({ responseId: "res-1" });
		const shown = (result.content[0] as { text: string }).text;

		expect(shown.length).toBeLessThanOrEqual(MAX_CHARS);
		expect(result.details.returnedChars).toBeLessThan(MAX_CHARS);
		expect(result.details.nextOffset).toBe(result.details.returnedChars);
	});

	test("finds text in the artifact", async () => {
		const result = await createCore().getSearchContent({
			responseId: "res-1",
			findText: "sunlight",
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: `Text matches (case-insensitive)\n\n1. "sunlight" ×1\n${collapsedResearch}`,
			},
		]);
		expect(result.details).toEqual({
			responseId: "res-1",
			type: "research",
			contentLength: serializedResearch.length,
			findMode: "case-insensitive",
			matchCount: 1,
			returnedMatches: 1,
			queryResults: [{ query: "sunlight", matchCount: 1 }],
		});
	});

	test("reports a find error against the artifact", async () => {
		const result = await createCore().getSearchContent({ responseId: "res-1", findText: "" });

		expect(result.content).toEqual([
			{
				type: "text",
				text: 'Unable to find "" in research artifact for responseId "res-1": findText must contain at least one non-empty string. Check findText and use a supported findMode.',
			},
		]);
		expect(result.details).toEqual({
			error: "findText must contain at least one non-empty string",
			responseId: "res-1",
			type: "research",
		});
	});

	test.each([
		{
			params: { offset: -1 },
			text: 'Invalid offset: received -1 for responseId "res-1"; offset must be a non-negative integer. Use 0 or a larger integer.',
			details: { error: "Invalid offset", offset: -1 },
		},
		{
			params: { limit: 0 },
			text: `Invalid limit: received 0 for responseId "res-1"; limit must be an integer from 1 to ${MAX_CHARS}. Use a value in that range.`,
			details: { error: "Invalid limit", limit: 0, maxLimit: MAX_CHARS },
		},
		{
			params: { offset: 99_999 },
			text: `Offset 99999 is out of range for responseId "res-1". Received offset 99999; valid range is 0-${serializedResearch.length}. Use an offset within that range.`,
			details: {
				error: "Offset out of range",
				offset: 99_999,
				contentLength: serializedResearch.length,
			},
		},
	])("rejects paging request $params", async ({ params, text, details }) => {
		const result = await createCore().getSearchContent({ responseId: "res-1", ...params });

		expect(result.content).toEqual([{ type: "text", text }]);
		expect(result.details).toEqual(details);
	});
});

describe("get_search_content: stored search", () => {
	test("pages the selected query and continues by queryIndex", async () => {
		const result = await createCore().getSearchContent({
			responseId: "search-1",
			queryIndex: 1,
			limit: 30,
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: '## Results for: "second"\n\n### \n\n---\nShowing chars 0-30 of 65. Use get_search_content({ responseId: "search-1", queryIndex: 1, offset: 30, limit: 30 }) for the next slice.',
			},
		]);
		expect(result.details).toEqual({
			responseId: "search-1",
			query: "second",
			resultCount: 1,
			contentLength: 65,
			offset: 0,
			limit: 30,
			returnedChars: 30,
			nextOffset: 30,
			truncated: true,
		});
	});

	test("finds text in the selected query", async () => {
		const result = await createCore().getSearchContent({
			responseId: "search-1",
			query: "first",
			findText: "One",
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: 'Text matches (case-insensitive)\n\n1. "One" ×3\n## Results for: "first" ### One https://one.test one snippet',
			},
		]);
		expect(result.details).toEqual({
			responseId: "search-1",
			query: "first",
			resultCount: 1,
			contentLength: 64,
			findMode: "case-insensitive",
			matchCount: 3,
			returnedMatches: 3,
			queryResults: [{ query: "One", matchCount: 3 }],
		});
	});

	test("reports a find error against the query", async () => {
		const result = await createCore().getSearchContent({
			responseId: "search-1",
			query: "first",
			findText: "",
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: 'Unable to find "" in query "first" for responseId "search-1": findText must contain at least one non-empty string. Check findText and use a supported findMode.',
			},
		]);
		expect(result.details).toEqual({
			error: "findText must contain at least one non-empty string",
			query: "first",
		});
	});

	test.each([
		{
			params: {},
			text: 'Specify query or queryIndex for responseId "search-1". Available queries: 0: "first", 1: "second", 2: "broken".',
			details: { error: "No query specified" },
		},
		{
			params: { query: "nope" },
			text: 'Query "nope" was not found for responseId "search-1". Received query="nope". Available queries: "first", "second", "broken". Use one of the available queries or queryIndex.',
			details: { error: "Query not found" },
		},
		{
			params: { queryIndex: 9 },
			text: 'Query index 9 is out of range for responseId "search-1". Received queryIndex=9; valid indexes are 0-2. Available queries: 0: "first", 1: "second", 2: "broken". Use one of the available indexes.',
			details: { error: "Index out of range" },
		},
		{
			params: { query: "broken" },
			text: 'Error retrieving query "broken" from responseId "search-1": provider failed. Check the stored search result and retry with another query or queryIndex if needed.',
			details: { error: "provider failed", query: "broken" },
		},
		{
			params: { query: "first", offset: -1 },
			text: 'Invalid offset: received -1 for query "first"; offset must be a non-negative integer. Use 0 or a larger integer.',
			details: { error: "Invalid offset", offset: -1 },
		},
		{
			params: { query: "first", offset: 99_999 },
			text: 'Offset 99999 is out of range for query "first" in responseId "search-1". Received offset 99999; valid range is 0-64. Use an offset within that range.',
			details: { error: "Offset out of range", offset: 99_999, contentLength: 64 },
		},
	])("rejects $params", async ({ params, text, details }) => {
		const result = await createCore().getSearchContent({ responseId: "search-1", ...params });

		expect(result.content).toEqual([{ type: "text", text }]);
		expect(result.details).toEqual(details);
	});
});

describe("get_search_content: stored fetch", () => {
	test("defaults to the only stored URL and heads the page with its title", async () => {
		const result = await createCore().getSearchContent({ responseId: "fetch-1", limit: 30 });

		expect(result.content).toEqual([
			{
				type: "text",
				text: `# One page\n\n${fetchedContent.slice(0, 30)}\n\n---\nShowing chars 0-30 of 200. Use get_search_content({ responseId: "fetch-1", urlIndex: 0, offset: 30, limit: 30 }) for the next slice.`,
			},
		]);
		expect(result.details).toEqual({
			url: "https://one.test",
			title: "One page",
			contentLength: 200,
			offset: 0,
			limit: 30,
			returnedChars: 30,
			nextOffset: 30,
			truncated: true,
		});
	});

	test("still reports the shown range on the final page", async () => {
		const result = await createCore().getSearchContent({ responseId: "fetch-1", offset: 190 });

		expect(result.content).toEqual([
			{
				type: "text",
				text: "# One page\n\nabcdefghij\n\n---\nShowing chars 190-200 of 200.",
			},
		]);
		expect(result.details).toEqual({
			url: "https://one.test",
			title: "One page",
			contentLength: 200,
			offset: 190,
			limit: MAX_CHARS,
			returnedChars: 10,
			nextOffset: null,
			truncated: false,
		});
	});

	test("does not count the page trailer against the output ceiling", async () => {
		// Pinned as-is: unlike research and search pages, the fetch trailer is appended
		// after slicing, so the shown text can exceed maxInlineContentChars.
		const result = await createCore().getSearchContent({ responseId: "fetch-1" });
		const shown = (result.content[0] as { text: string }).text;

		expect(shown.length).toBeGreaterThan(MAX_CHARS);
		expect(result.details.returnedChars).toBe(MAX_CHARS);
	});

	test("heads found text with the page title", async () => {
		const result = await createCore().getSearchContent({
			responseId: "fetch-1",
			findText: "abc",
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: `# One page\n\nText matches (case-insensitive)\n\n1. "abc" ×20\n${fetchedContent}`,
			},
		]);
		expect(result.details).toEqual({
			url: "https://one.test",
			title: "One page",
			contentLength: 200,
			findMode: "case-insensitive",
			matchCount: 20,
			returnedMatches: 20,
			queryResults: [{ query: "abc", matchCount: 20 }],
		});
	});

	test("reports a find error against the URL", async () => {
		const result = await createCore().getSearchContent({
			responseId: "fetch-1",
			findText: "",
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: 'Unable to find "" in URL "https://one.test" for responseId "fetch-1": findText must contain at least one non-empty string. Check findText and use a supported findMode.',
			},
		]);
		expect(result.details).toEqual({
			error: "findText must contain at least one non-empty string",
			url: "https://one.test",
		});
	});

	test.each([
		{
			params: {},
			text: 'Specify url or urlIndex for responseId "fetch-2". Available URLs:\n  0: https://one.test\n  1: https://two.test',
			details: { error: "No URL specified" },
		},
		{
			params: { url: "https://nope.test" },
			text: 'URL "https://nope.test" was not found for responseId "fetch-2". Received url="https://nope.test". Available URLs:\n  https://one.test\n  https://two.test\nUse one of the available URLs or urlIndex.',
			details: { error: "URL not found" },
		},
		{
			params: { urlIndex: 9 },
			text: 'URL index 9 is out of range for responseId "fetch-2". Received urlIndex=9; valid indexes are 0-1. Available URLs:\n  0: https://one.test\n  1: https://two.test\nUse one of the available indexes.',
			details: { error: "Index out of range" },
		},
		{
			params: { responseId: "fetch-3" },
			text: 'Error retrieving URL "https://one.test" from responseId "fetch-3": fetch failed. Check the stored fetch result and retry with another URL or urlIndex if needed.',
			details: { error: "fetch failed", url: "https://one.test" },
		},
		{
			params: { responseId: "fetch-2", url: "https://two.test", offset: -1 },
			text: 'Invalid offset: received -1 for URL "https://two.test"; offset must be a non-negative integer. Use 0 or a larger integer.',
			details: { error: "Invalid offset", offset: -1 },
		},
		{
			params: { responseId: "fetch-2", url: "https://two.test", offset: 99_999 },
			text: 'Offset 99999 is out of range for URL "https://two.test" in responseId "fetch-2". Received offset 99999; valid range is 0-200. Use an offset within that range.',
			details: { error: "Offset out of range", offset: 99_999, contentLength: 200 },
		},
	])("rejects $params", async ({ params, text, details }) => {
		const result = await createCore().getSearchContent({ responseId: "fetch-2", ...params });

		expect(result.content).toEqual([{ type: "text", text }]);
		expect(result.details).toEqual(details);
	});
});

describe("get_search_content: dispatch", () => {
	test("rejects an unknown responseId", async () => {
		const result = await createCore().getSearchContent({ responseId: "nope" });

		expect(result.content).toEqual([
			{
				type: "text",
				text: 'Error: No stored results for responseId "nope". Use a responseId returned by web_search, source_check, or fetch_content.',
			},
		]);
		expect(result.details).toEqual({ error: "Not found", responseId: "nope" });
	});

	test("rejects a responseId without usable stored data", async () => {
		const result = await createCore().getSearchContent({ responseId: "invalid-1" });

		expect(result.content).toEqual([
			{
				type: "text",
				text: 'Invalid stored data for responseId "invalid-1": received type "search". Use a responseId returned by web_search, source_check, or fetch_content.',
			},
		]);
		expect(result.details).toEqual({ error: "Invalid data" });
	});

	test("rejects findMode without findText", async () => {
		const result = await createCore().getSearchContent({
			responseId: "fetch-1",
			findMode: "fuzzy",
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: 'findMode "fuzzy" requires findText; provide findText or omit findMode.',
			},
		]);
		expect(result.details).toEqual({ error: "findMode requires findText" });
	});
});
