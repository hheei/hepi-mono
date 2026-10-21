// Host-neutral contract for the web tools. The Pi extension (index.ts) and the
// MCP server (mcp-server.ts) both drive tools through WebToolCore so tool
// behavior lives in one place; each host keeps its own schemas and transport.

import type { FindMode } from "./content-find.ts";
import type { RecencyFilter } from "./source-check.ts";

export type WebToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface WebToolResult {
	content: WebToolContent[];
	details: Record<string, unknown>;
	isError?: boolean;
	/** Data for programmatic callers such as Pi codemode scripts; never sent to the model or over MCP. */
	structuredContent?: WebSearchStructuredContent | FetchContentStructuredContent;
}

export type WebSearchStructuredContent = {
	responseId: string;
	fetchId: string | null;
	queries: Array<{
		query: string;
		answer: string;
		error: string | null;
		provider?: string | undefined;
		providers?: string[] | undefined;
		results: Array<{ title: string; url: string; snippet: string }>;
	}>;
};

export type FetchContentStructuredContent = {
	responseId: string | null;
	urls: Array<{
		url: string;
		title: string;
		content: string;
		error: string | null;
		mimeType?: string | undefined;
		status?: number | undefined;
		duration?: number | undefined;
	}>;
};

export interface WebSearchCallParams {
	query?: string | undefined;
	queries?: string[] | undefined;
	numResults?: number | undefined;
	includeContent?: boolean | undefined;
	recencyFilter?: RecencyFilter | undefined;
	domainFilter?: string[] | undefined;
	category?: string | undefined;
	provider?: string | string[] | undefined;
	proxy?: string | undefined;
}

export interface FetchContentCallParams {
	url?: string | undefined;
	urls?: string[] | undefined;
	mode?: string | undefined;
	forceClone?: boolean | undefined;
	proxy?: string | undefined;
}

export interface GetSearchContentCallParams {
	responseId: string;
	query?: string | undefined;
	queryIndex?: number | undefined;
	url?: string | undefined;
	urlIndex?: number | undefined;
	offset?: number | undefined;
	limit?: number | undefined;
	findText?: string | string[] | undefined;
	findMode?: FindMode | undefined;
}

export interface SourceCheckCallParams {
	claim: string;
	queries?: string[] | undefined;
	numResults?: number | undefined;
	fetchContent?: boolean | undefined;
	recencyFilter?: RecencyFilter | undefined;
	domainFilter?: string[] | undefined;
	provider?: string | string[] | undefined;
	proxy?: string | undefined;
}

export interface WebToolCore {
	webSearch(params: WebSearchCallParams, signal?: AbortSignal): Promise<WebToolResult>;
	fetchContent(params: FetchContentCallParams, signal?: AbortSignal): Promise<WebToolResult>;
	getSearchContent(
		params: GetSearchContentCallParams,
		signal?: AbortSignal,
	): Promise<WebToolResult>;
	sourceCheck(params: SourceCheckCallParams, signal?: AbortSignal): Promise<WebToolResult>;
}
