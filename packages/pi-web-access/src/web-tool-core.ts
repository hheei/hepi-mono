import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { DEFAULT_MAX_BYTES, MAX_BUDGET_MULTIPLIER } from "@hheei/pi-ext-core";
import pLimit from "p-limit";
import { type AuthFetchProfile, resolveAuthFetchProfile } from "./auth-fetch.ts";
import { type FindMode, findContent } from "./content-find.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import {
	FETCH_MODES,
	type FetchContentParams,
	type FetchMode,
	type FetchModeConfig,
	type FetchRequest,
	type NormalizedFetchContentParams,
	resolveFetchRequest,
} from "./fetch-params.ts";
import {
	assertSearchProviderSelectionAllowed,
	normalizeSearchProviderSelection,
	type SearchProvider,
	type SearchProviderSelection,
	search,
} from "./gemini-search.ts";
import type { SearchResult } from "./perplexity.ts";
import {
	buildResearchArtifact,
	getResearchArtifact,
	type RecencyFilter,
	type ResearchArtifact,
	storeResearchArtifact,
	withClaimAssessment,
} from "./source-check.ts";
import {
	generateId,
	getResult,
	type QueryResultData,
	type StoredSearchData,
	storeResult,
} from "./storage.ts";
import type { SummaryMeta } from "./summary-review.ts";
import { getWebSearchConfigPath, readWebSearchSection, runWithProxy } from "./utils.ts";
import type {
	FetchContentCallParams,
	FetchContentStructuredContent,
	GetSearchContentCallParams,
	SourceCheckCallParams,
	WebSearchCallParams,
	WebSearchStructuredContent,
	WebToolContent,
	WebToolCore,
	WebToolResult,
} from "./web-tool-contract.ts";

export const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();

export interface WebSearchConfig {
	anysearchApiKey?: unknown;
	xcrawlApiKey?: unknown;
	brightdataApiKey?: unknown;
	brightdataSerpZone?: unknown;
	kagiApiKey?: unknown;
	ollamaApiKey?: unknown;
	serpbaseApiKey?: unknown;
	serpapiApiKey?: unknown;
	serperApiKey?: unknown;
	serplyApiKey?: unknown;
	youApiKey?: unknown;
	baizhiApiKey?: unknown;
	zaiApiKey?: unknown;
	tinyfishApiKey?: unknown;
	valyuApiKey?: unknown;
	keenableApiKey?: unknown;
	ceramicApiKey?: unknown;
	linkupApiKey?: unknown;
	linkupDepth?: unknown;
	deepseekApiKey?: unknown;
	degoogBaseUrl?: unknown;
	degoogApiKey?: unknown;
	degoogEngines?: unknown;
	degoogHeaders?: unknown;
	xaiApiKey?: unknown;
	provider?: unknown;
	searchProvider?: unknown;
	workflow?: string;
	curatorTimeoutSeconds?: unknown;
	autoOpenBrowser?: unknown;
	curatorRemote?: unknown;
	summaryModel?: string;
	summaryGenerationDeadlineMs?: unknown;
	summaryInstructions?: unknown;
	maxInlineContentChars?: unknown;
	fetch?: {
		defaultMode?: unknown;
		allowedModes?: unknown;
		/** Provider for `mode: "answer"`; must be configured together with `answerModel`. */
		answerProvider?: unknown;
		/** Model id for `mode: "answer"`; must be configured together with `answerProvider`. */
		answerModel?: unknown;
	};
	webSearch?: {
		enabled?: boolean;
		allowedProviders?: unknown;
	};
	tools?: Partial<Record<keyof ToolNames, { enabled?: boolean }>>;
	toolActivation?: unknown;
	toolExposure?: unknown;
	enableWebLoader?: unknown;
	commands?: Partial<
		Record<"websearch" | "curator" | "search" | "google-account", { enabled?: boolean }>
	>;
	toolNames?: Partial<ToolNames>;
	shortcuts?: {
		curate?: KeyId;
		activity?: KeyId;
	};
	ssrf?: {
		/** CIDR ranges exempted from the SSRF guard (e.g. fake-IP proxy ranges). */
		allowRanges?: string[];
		/** Skip local hostname DNS preflight when an HTTP(S)_PROXY env var applies. */
		trustEnvProxy?: boolean;
	};
}

export function loadConfig(): WebSearchConfig {
	return readWebSearchSection() as WebSearchConfig;
}

export type ToolNames = {
	webSearch: string;
	sourceCheck: string;
	fetchContent: string;
	getSearchContent: string;
};

export const DEFAULT_TOOL_NAMES: ToolNames = {
	webSearch: "web_search",
	sourceCheck: "source_check",
	fetchContent: "fetch_content",
	getSearchContent: "get_search_content",
};
const SEARCH_QUERY_CONCURRENCY = 3;

export function resolveFetchModeConfig(config: WebSearchConfig): FetchModeConfig {
	const configuredModes = config.fetch?.allowedModes ?? FETCH_MODES;
	if (
		!Array.isArray(configuredModes) ||
		configuredModes.length === 0 ||
		configuredModes.some((mode) => !FETCH_MODES.includes(mode as FetchMode))
	) {
		throw new Error(
			`fetch.allowedModes in ${WEB_SEARCH_CONFIG_PATH} must be a non-empty array containing only "readable", "raw", or "answer"`,
		);
	}
	const allowedModes = configuredModes as readonly FetchMode[];
	const duplicateMode = allowedModes.find((mode, index) => allowedModes.indexOf(mode) !== index);
	if (duplicateMode) {
		throw new Error(
			`fetch.allowedModes in ${WEB_SEARCH_CONFIG_PATH} must not contain duplicates: "${duplicateMode}"`,
		);
	}
	const defaultMode = config.fetch?.defaultMode ?? "readable";
	if (!allowedModes.includes(defaultMode as FetchMode)) {
		throw new Error(
			`fetch.defaultMode in ${WEB_SEARCH_CONFIG_PATH} must be one of fetch.allowedModes`,
		);
	}
	return { defaultMode: defaultMode as FetchMode, allowedModes };
}

// Limit each batch independently so separate Pi tool calls can still run in parallel.
export function runSearchQueries<T>(
	queries: string[],
	run: (query: string, index: number) => Promise<T>,
): Promise<T[]> {
	const limit = pLimit(SEARCH_QUERY_CONCURRENCY);
	return Promise.all(queries.map((query, index) => limit(() => run(query, index))));
}

export function isToolEnabled(config: WebSearchConfig, key: keyof ToolNames): boolean {
	const override = config.tools?.[key]?.enabled;
	if (typeof override === "boolean") return override;
	return (key !== "webSearch" && key !== "sourceCheck") || config.webSearch?.enabled !== false;
}

function joinToolNames(names: string[]): string {
	if (names.length === 0) return "stored content";
	if (names.length === 1) return names[0] ?? "stored content";
	if (names.length === 2) return `${names[0] ?? ""} or ${names[1] ?? ""}`;
	const last = names[names.length - 1] ?? "";
	return `${names.slice(0, -1).join(", ")}, or ${last}`;
}

export function normalizeProviderInput(
	value: unknown,
	label = "provider",
): SearchProviderSelection | undefined {
	if (value === undefined) return undefined;
	return normalizeSearchProviderSelection(value, label);
}

export function resolveRequestedProvider(requested: unknown): SearchProviderSelection {
	const normalizedRequested = normalizeProviderInput(requested);
	if (normalizedRequested && normalizedRequested !== "auto") {
		assertSearchProviderSelectionAllowed(normalizedRequested, "Requested provider");
		return normalizedRequested;
	}
	const config = loadConfig();
	const provider =
		normalizeProviderInput(
			config.searchProvider ?? config.provider,
			`provider in ${WEB_SEARCH_CONFIG_PATH}`,
		) ?? "auto";
	assertSearchProviderSelectionAllowed(
		provider,
		`configured provider in ${WEB_SEARCH_CONFIG_PATH}`,
	);
	return provider;
}

export function toCuratorProvider(provider: SearchProviderSelection): SearchProvider | undefined {
	if (Array.isArray(provider)) return "all";
	return provider === "auto" ? undefined : provider;
}

export function normalizeRecencyFilter(value: unknown): RecencyFilter | undefined {
	return value === "day" || value === "week" || value === "month" || value === "year"
		? value
		: undefined;
}

export function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

// Some local models serialize a multi-query list into the single-string `query`
// field as a JSON array (query: "[\"a\", \"b\"]") instead of using the
// `queries` parameter. Forwarding that raw string verbatim makes every backend
// search for the literal array text and return zero results, with no signal to
// the model that its argument shape was wrong. Expand a string that parses as a
// JSON array of strings so each element is searched independently.
export function expandQueryString(query: unknown): string[] {
	if (typeof query !== "string") return [];
	const trimmed = query.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			// Only expand an unambiguously string-only array. Mixed or non-string
			// arrays are kept as the literal query so we never silently drop
			// members or collapse them into an empty search.
			if (
				Array.isArray(parsed) &&
				parsed.every((entry): entry is string => typeof entry === "string")
			) {
				return parsed.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
			}
		} catch {
			// Not JSON — treat as a literal query string.
		}
	}
	return [query];
}

let extractModulePromise: Promise<typeof import("./extract.ts")> | undefined;
export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	extractModulePromise = extractModulePromise ?? import("./extract.ts");
	const extractModule = await extractModulePromise;
	return extractModule.fetchAllContent(urls, signal, options);
}

/** Returns content for every URL in order: the provider's content where it supplied some,
 * and a page fetch only for the URLs it did not cover. */
export async function fetchUncoveredContent(
	urls: string[],
	provided: ExtractedContent[] | undefined,
	fetchPages: (urls: string[]) => Promise<ExtractedContent[]>,
): Promise<ExtractedContent[]> {
	const providedByUrl = new Map<string, ExtractedContent>();
	for (const content of provided ?? []) {
		if (!providedByUrl.has(content.url)) providedByUrl.set(content.url, content);
	}
	const missing = urls.filter((url) => !providedByUrl.has(url));
	const fetched = missing.length > 0 ? await fetchPages(missing) : [];
	let next = 0;
	return urls.map((url) => {
		const cached = providedByUrl.get(url);
		if (cached) return cached;
		const nextFetched = fetched[next++];
		if (!nextFetched) {
			return { url, title: "", content: "", error: "Missing fetch content" };
		}
		return nextFetched;
	});
}

export function withRegisteredFetchOptions(
	options: ExtractOptions | undefined,
	toolNames: ExtractOptions["toolNames"],
	proxy?: string,
): ExtractOptions {
	return {
		...(options ?? {}),
		toolNames,
		...(proxy !== undefined ? { proxy } : {}),
	};
}

function isAbortError(err: unknown): boolean {
	return (err instanceof Error ? err.message : String(err)).toLowerCase().includes("abort");
}

/** One page is one result, so its default is the shared single-call budget. */
const DEFAULT_MAX_INLINE_CONTENT_CHARS = DEFAULT_MAX_BYTES;
const MIN_INLINE_CONTENT_CHARS = 1_000;
/**
 * The shared byte budget with the ceiling the tool-call multiplier may reach, expressed in
 * characters because this tool pages content by character offset. A page larger than this cannot be
 * retrieved in one call even by a caller that asks for it, so the bound is the page size, not a
 * preference.
 */
const MAX_INLINE_CONTENT_CHARS = DEFAULT_MAX_BYTES * MAX_BUDGET_MULTIPLIER;

export function getMaxInlineContentChars(config = loadConfig()): number {
	const value = config.maxInlineContentChars;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isInteger(value) ||
		value < MIN_INLINE_CONTENT_CHARS
	) {
		return DEFAULT_MAX_INLINE_CONTENT_CHARS;
	}
	return Math.min(value, MAX_INLINE_CONTENT_CHARS);
}

export function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
	return results.map(({ thumbnail, frames, ...rest }) => rest);
}

function searchStructuredContent(
	responseId: string,
	fetchId: string | null,
	results: QueryResultData[],
): WebSearchStructuredContent {
	return {
		responseId,
		fetchId,
		queries: results.map(({ query, answer, error, provider, providers, results }) => ({
			query,
			answer,
			error,
			provider,
			providers,
			results: results.map(({ title, url, snippet }) => ({ title, url, snippet })),
		})),
	};
}

// Full content per URL, without thumbnails or frames.
function fetchStructuredContent(
	responseId: string | null,
	results: ExtractedContent[],
): FetchContentStructuredContent {
	return {
		responseId,
		urls: results.map(({ url, title, content, error, mimeType, status, duration }) => ({
			url,
			title,
			content,
			error,
			mimeType,
			status,
			duration,
		})),
	};
}

function initialContentSlice(
	content: string,
	maxChars: number,
): {
	text: string;
	endOffset: number;
	totalBytes: number;
	totalLines: number;
	shownBytes: number;
	shownLines: number;
} {
	let endOffset = pageEnd(content, 0, Math.min(content.length, maxChars));
	if (endOffset < content.length) {
		const lineBreak = content.lastIndexOf("\n", endOffset);
		if (lineBreak >= Math.floor(maxChars * 0.8)) endOffset = lineBreak + 1;
	}
	const text = content.slice(0, endOffset);
	return {
		text,
		endOffset,
		totalBytes: Buffer.byteLength(content),
		totalLines: content.length === 0 ? 0 : content.split("\n").length,
		shownBytes: Buffer.byteLength(text),
		shownLines: text.length === 0 ? 0 : text.split("\n").length,
	};
}

function normalizeFindQueries(value: string | string[]): string[] {
	const queries = (Array.isArray(value) ? value : [value])
		.map((query) => query.trim())
		.filter(Boolean);
	if (queries.length === 0) throw new Error("findText must contain at least one non-empty string");
	return queries;
}

type GetSearchContentParams = GetSearchContentCallParams;

export type RawGetSearchContentParams = Omit<GetSearchContentParams, "findMode"> & {
	findMode?: unknown;
};

function normalizeFindMode(value: unknown): FindMode | undefined {
	if (value === undefined) return undefined;
	if (value === "exact" || value === "case-insensitive" || value === "fuzzy") return value;
	throw new Error('findMode must be "exact", "case-insensitive", or "fuzzy"');
}

function normalizeGetSearchContentParams(
	params: RawGetSearchContentParams,
): GetSearchContentParams {
	const normalized: GetSearchContentParams = {
		...params,
		findMode: normalizeFindMode(params.findMode),
	};

	if (normalized.query?.trim() === "") delete normalized.query;
	if (normalized.url?.trim() === "") delete normalized.url;

	if (normalized.findText !== undefined) {
		delete normalized.offset;
		delete normalized.limit;
	}

	return normalized;
}

function formatInputValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	if (results.length === 0) {
		return answer ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.` : "No results found.";
	}
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function formatSourceCheckResult(
	artifact: ResearchArtifact,
	getSearchContentTool: string | null = DEFAULT_TOOL_NAMES.getSearchContent,
): string {
	const assessment = artifact.claims?.[0];
	const lines = [`# Source check: ${artifact.query}`, ""];
	if (assessment) {
		lines.push(`**Status:** ${assessment.status} (confidence ${assessment.confidence.toFixed(2)})`);
		lines.push(`**Rationale:** ${assessment.rationale}`);
		if (assessment.supporting_passages.length > 0)
			lines.push(`**Supporting passages:** ${assessment.supporting_passages.join(", ")}`);
		if (assessment.contradicting_passages.length > 0)
			lines.push(`**Contradicting passages:** ${assessment.contradicting_passages.join(", ")}`);
		lines.push("");
	}
	if (artifact.sources.length > 0) {
		lines.push("## Sources");
		for (const source of artifact.sources)
			lines.push(`${source.rank}. [${source.quality}] ${source.title}\n   ${source.url}`);
		lines.push("");
	}
	if (artifact.errors?.length)
		lines.push(
			`Search errors: ${artifact.errors.map((entry) => `${entry.query}: ${entry.error}`).join("; ")}`,
		);
	lines.push(
		getSearchContentTool
			? `Artifact responseId: ${artifact.id} (retrievable via ${getSearchContentTool}).`
			: `Artifact responseId: ${artifact.id}. Content retrieval is not registered.`,
	);
	return lines.join("\n");
}

function duplicateQuerySet(results: QueryResultData[]): Set<string> {
	const counts = new Map<string, number>();
	for (const result of results) {
		counts.set(result.query, (counts.get(result.query) ?? 0) + 1);
	}
	const duplicates = new Set<string>();
	for (const [query, count] of counts) {
		if (count > 1) duplicates.add(query);
	}
	return duplicates;
}

function formatQueryHeader(
	query: string,
	provider: string | undefined,
	duplicateQueries: Set<string>,
): string {
	const suffix = duplicateQueries.has(query) && provider ? ` (${provider})` : "";
	return `## Query: "${query}"${suffix}\n\n`;
}

function hasFullInlineCoverage(
	urls: string[],
	inlineContent: ExtractedContent[] | undefined,
): boolean {
	if (!inlineContent || inlineContent.length === 0) return false;
	const coveredUrls = new Set(inlineContent.map((c) => c.url));
	return urls.every((url) => coveredUrls.has(url));
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	const providers = queryData.providers ?? (queryData.provider ? [queryData.provider] : []);
	if (providers.length > 0)
		output += `**Provider${providers.length === 1 ? "" : "s"}:** ${providers.join(", ")}\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}${r.snippet ? `\n\n${r.snippet}` : ""}\n\n`;
	}
	return output;
}

function boundSearchPresentation(
	text: string,
	guidance: string,
	truncationGuidance: string,
	maxChars: number,
): {
	text: string;
	truncated: boolean;
	originalChars: number;
	returnedChars: number;
	omittedChars: number;
} {
	const fullText = `${text}${guidance}`;
	if (fullText.length <= maxChars) {
		return {
			text: fullText,
			truncated: false,
			originalChars: text.length,
			returnedChars: text.length,
			omittedChars: 0,
		};
	}
	const marker = `\n\n---\n[Output truncated.]${truncationGuidance}`;
	// Reserve marker space so the complete model-visible response never exceeds the configured ceiling.
	const prefixLength = maxChars - marker.length;
	const bounded = `${text.slice(0, prefixLength)}${marker}`;
	return {
		text: bounded,
		truncated: true,
		originalChars: text.length,
		returnedChars: prefixLength,
		omittedChars: text.length - prefixLength,
	};
}

export type SummaryWorkflow = "summary-review" | "auto-summary";
export type FetchedContentData = StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };

export interface SearchReturnOptions {
	queryList: string[];
	results: QueryResultData[];
	urls: string[];
	includeContent: boolean;
	inlineContent?: ExtractedContent[] | undefined;
	curated?: boolean | undefined;
	curatedFrom?: number | undefined;
	workflow?: SummaryWorkflow | undefined;
	approvedSummary?: string | undefined;
	summaryMeta?: SummaryMeta | undefined;
	proxy?: string | undefined;
}

/** Tool names and limits a host resolved once at startup. */
export interface WebToolCoreSettings {
	toolNames: ToolNames;
	enabledTools: Record<keyof ToolNames, boolean>;
	/** Output ceiling for search results and stored-content pages. fetch_content rereads config per call. */
	maxInlineContentChars: number;
	fetchModes: FetchModeConfig;
}

export interface PageAnswerRequest {
	question: string;
	pageText: string;
	sourceUrl: string;
	model?: string;
}

/** Everything that differs between hosts. Pi supplies session persistence, background
 * notifications, and page answers; the standalone host keeps results in memory only. */
export interface WebToolCoreHost {
	settings: WebToolCoreSettings;
	/** Store fetched page content under id so the retrieval tool can page through it. */
	storeFetchedContent(id: string, data: FetchedContentData): void;
	/** Called after search or research results are stored in memory. */
	publishResult?(data: StoredSearchData): void;
	/** Fetch includeContent pages the provider did not cover in the background and return
	 * their responseId. When omitted, web_search awaits the same fetch before returning. */
	startBackgroundFetch?(
		urls: string[],
		proxy?: string,
		provided?: ExtractedContent[],
	): string | null;
	/** Answers fetch_content mode "answer"; requires the host's model access. */
	answerFromPage?(
		request: PageAnswerRequest,
		extensionContext: ExtensionContext | undefined,
		signal?: AbortSignal,
	): Promise<{ text: string }>;
	/** Extraction options every fetch in this host adds (for example direct-image policy). */
	extractOptions?: Pick<ExtractOptions, "rejectDirectImages">;
}

export type WebToolUpdate = (update: {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}) => void;

/** Per-call inputs only Pi has: its live ExtensionContext and partial-result callback. */
export interface WebToolCallOptions {
	extensionContext?: ExtensionContext | undefined;
	onUpdate?: WebToolUpdate | undefined;
}

export interface WebSearchCallOptions extends WebToolCallOptions {
	/** Generates an auto-summary after searches complete; returning a tool result ends the call. */
	summarize?:
		| ((
				results: QueryResultData[],
		  ) => Promise<WebToolResult | { approvedSummary: string; summaryMeta: SummaryMeta }>)
		| undefined;
	/** Wait for includeContent pages and store them with the result instead of fetching in the background. */
	awaitContent?: boolean | undefined;
}

// Pi's TypeBox schemas type enums as plain strings; the core normalizes them.
export type WebSearchParams = Omit<WebSearchCallParams, "recencyFilter"> & {
	recencyFilter?: string | undefined;
	workflow?: string | undefined;
};
export type FetchContentToolParams = FetchContentCallParams & FetchContentParams;
export type SourceCheckParams = Omit<SourceCheckCallParams, "recencyFilter"> & {
	recencyFilter?: string | undefined;
};

export interface WebToolCoreInstance extends WebToolCore {
	webSearch(
		params: WebSearchParams,
		signal?: AbortSignal,
		call?: WebSearchCallOptions,
	): Promise<WebToolResult>;
	fetchContent(
		params: FetchContentToolParams,
		signal?: AbortSignal,
		call?: WebToolCallOptions,
	): Promise<WebToolResult>;
	getSearchContent(params: RawGetSearchContentParams, signal?: AbortSignal): Promise<WebToolResult>;
	sourceCheck(
		params: SourceCheckParams,
		signal?: AbortSignal,
		call?: WebToolCallOptions,
	): Promise<WebToolResult>;
	/** Formats and stores search results; the Pi curator reuses it for curated returns. */
	buildSearchReturn(opts: SearchReturnOptions): WebToolResult;
}

/** Names fetch guidance may point at: only tools registered this session. */
export function registeredFetchToolNames(
	settings: WebToolCoreSettings,
): NonNullable<ExtractOptions["toolNames"]> {
	return {
		...(settings.enabledTools.webSearch ? { webSearch: settings.toolNames.webSearch } : {}),
		...(settings.enabledTools.fetchContent
			? { fetchContent: settings.toolNames.fetchContent }
			: {}),
		...(settings.enabledTools.getSearchContent
			? { getSearchContent: settings.toolNames.getSearchContent }
			: {}),
	};
}

export function storedContentSourceNames(settings: WebToolCoreSettings): string {
	return joinToolNames([
		...(settings.enabledTools.webSearch ? [settings.toolNames.webSearch] : []),
		...(settings.enabledTools.sourceCheck ? [settings.toolNames.sourceCheck] : []),
		...(settings.enabledTools.fetchContent ? [settings.toolNames.fetchContent] : []),
	]);
}

/** Keeps a page end from splitting a surrogate pair: it moves back one code unit,
 * or past the pair when moving back would leave the page empty. */
function pageEnd(content: string, offset: number, end: number): number {
	if (end <= offset || end >= content.length) return end;
	const high = content.charCodeAt(end - 1);
	const low = content.charCodeAt(end);
	if (high < 0xd800 || high > 0xdbff || low < 0xdc00 || low > 0xdfff) return end;
	return end - 1 > offset ? end - 1 : end + 1;
}

/** Slices content from offset and appends the next-slice instructions, shrinking
 * the slice so the whole page, instructions included, stays within maxChars. */
function sliceWithContinuation(
	content: string,
	offset: number,
	limit: number,
	maxChars: number,
	continuationAt: (endOffset: number) => string,
): { endOffset: number; text: string } {
	let endOffset = pageEnd(content, offset, offset + Math.min(limit, content.length - offset));
	let continuation = "";
	while (endOffset < content.length) {
		continuation = continuationAt(endOffset);
		const overflow = endOffset - offset + continuation.length - maxChars;
		if (overflow <= 0) break;
		endOffset = pageEnd(content, offset, endOffset - overflow);
	}
	return {
		endOffset,
		text: content.slice(offset, endOffset) + (endOffset < content.length ? continuation : ""),
	};
}

/** Everything presenting a fetch result needs. Answers are shown; the original pages are stored. */
export interface FetchPresentation {
	mode: FetchMode;
	/** Retrieval tool to point at, or null when get_search_content is not registered. */
	getSearchContentTool: string | null;
	/** responseId of the stored original content, or null when it was not stored. */
	responseId: string | null;
	maxChars: number;
	/** URLs the call asked for, in request order. */
	urlList: string[];
	structuredContent: FetchContentStructuredContent;
}

export function presentSingleFetch(
	presentation: FetchPresentation,
	result: ExtractedContent | undefined,
	params: FetchContentToolParams,
): WebToolResult {
	const { mode, getSearchContentTool, responseId, maxChars, urlList, structuredContent } =
		presentation;
	if (!result) {
		return {
			isError: true,
			content: [{ type: "text", text: "Error: No result found" }],
			details: { error: "No result found" },
		};
	}
	if (result.error) {
		return {
			isError: true,
			content: [{ type: "text", text: `Error: ${result.error}` }],
			structuredContent,
			details: {
				urls: urlList,
				urlCount: 1,
				successful: 0,
				error: result.error,
				...(responseId !== null ? { responseId } : {}),
				prompt: params.prompt,
				timestamp: params.timestamp,
				frames: params.frames,
			},
		};
	}

	const fullLength = result.content.length;
	const slice = initialContentSlice(result.content, maxChars);
	const truncated = slice.endOffset < fullLength;
	let output = slice.text;

	if (truncated) {
		output += `\n\n---\nShowing ${slice.endOffset} of ${fullLength} chars, ${slice.shownBytes} of ${slice.totalBytes} bytes, and ${slice.shownLines} of ${slice.totalLines} lines. `;
		if (mode === "answer")
			output += "Stored content is the original source, not the remaining answer. ";
		if (responseId === null) {
			output += "Authenticated fetch cache is off; repeat the fetch to read more.";
		} else if (getSearchContentTool === null) {
			output += "Content retrieval is not registered.";
		} else if (mode === "answer") {
			output += `Use ${getSearchContentTool}({ responseId: "${responseId}", urlIndex: 0, offset: 0 }) to read the original source from the beginning.`;
		} else {
			output += `Use ${getSearchContentTool}({ responseId: "${responseId}", urlIndex: 0, offset: ${slice.endOffset} }) for the next slice.`;
		}
	}

	const content: WebToolContent[] = [];
	if (result.frames?.length) {
		for (const frame of result.frames) {
			content.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
			content.push({ type: "text", text: `Frame at ${frame.timestamp}` });
		}
	} else if (result.thumbnail) {
		content.push({
			type: "image",
			data: result.thumbnail.data,
			mimeType: result.thumbnail.mimeType,
		});
	}
	content.push({ type: "text", text: output });
	if (!truncated && responseId !== null && getSearchContentTool !== null) {
		const storedLabel = mode === "answer" ? "Original source content" : "Full content";
		content.push({
			type: "text",
			text: `\n---\n${storedLabel} is stored as responseId "${responseId}". Use ${getSearchContentTool}({ responseId: "${responseId}", urlIndex: 0, offset: 0 }) to retrieve it.`,
		});
	}

	const imageCount = (result.frames?.length ?? 0) + (result.thumbnail ? 1 : 0);
	return {
		content,
		structuredContent,
		details: {
			urls: urlList,
			urlCount: 1,
			successful: 1,
			totalChars: fullLength,
			title: result.title,
			...(responseId !== null ? { responseId } : {}),
			truncated,
			hasImage: imageCount > 0,
			imageCount,
			prompt: params.prompt,
			timestamp: params.timestamp,
			frames: params.frames,
			duration: result.duration,
			mode,
			mimeType: result.mimeType,
			status: result.status,
			totalBytes: slice.totalBytes,
			totalLines: slice.totalLines,
			shownBytes: slice.shownBytes,
			shownLines: slice.shownLines,
		},
	};
}

export function presentFetchedUrls(
	presentation: FetchPresentation,
	results: ExtractedContent[],
): WebToolResult {
	const { mode, getSearchContentTool, responseId, maxChars, urlList, structuredContent } =
		presentation;
	const successful = results.filter((result) => !result.error).length;
	const totalChars = results.reduce((sum, result) => sum + result.content.length, 0);

	// Answers are generated, not stored, so they must be shown here in full up to the output limit.
	let budget = mode === "answer" ? maxChars : 0;
	let output = mode === "answer" ? "## Page answers\n" : "## Fetched URLs\n\n";
	for (const { url, title, content, error } of results) {
		if (mode !== "answer") {
			output += error
				? `- ${url}: Error - ${error}\n`
				: `- ${title || url} (${content.length} chars)\n`;
		} else if (error) {
			output += `\n### ${url}\nError: ${error}\n`;
		} else {
			const shown = content.slice(0, budget);
			budget -= shown.length;
			const marker =
				shown.length === content.length
					? ""
					: `\n[answer ${shown.length ? "truncated at the output limit;" : "omitted; earlier answers used the output limit,"} fetch fewer URLs per call for complete answers]`;
			output += `\n### ${title || url}\n${shown}${marker}\n`;
		}
	}
	if (responseId === null) {
		output += "\n---\nAuthenticated fetch cache is off; repeat the fetch to read content.";
	} else if (getSearchContentTool === null) {
		output += "\n---\nContent retrieval is not registered.";
	} else if (mode === "answer") {
		output += `\n---\nStored content is the original source pages, not the answers. Use ${getSearchContentTool}({ responseId: "${responseId}", urlIndex: 0, offset: 0 }) to read the first source; urlIndex follows the order above.`;
	} else {
		output += `\n---\nUse ${getSearchContentTool}({ responseId: "${responseId}", urlIndex: 0 }) to retrieve bounded content slices.`;
	}

	return {
		...(successful === 0 ? { isError: true } : {}),
		content: [{ type: "text", text: output }],
		structuredContent,
		details: {
			urls: urlList,
			urlCount: urlList.length,
			successful,
			totalChars,
			...(responseId !== null ? { responseId } : {}),
		},
	};
}

export function createWebToolCore(host: WebToolCoreHost): WebToolCoreInstance {
	const { settings } = host;
	const toolNames = settings.toolNames;
	const getSearchContentEnabled = settings.enabledTools.getSearchContent;
	const fetchModeConfig = settings.fetchModes;
	const registeredToolNames = registeredFetchToolNames(settings);
	const storedContentSources = storedContentSourceNames(settings);

	function fetchOptions(options: ExtractOptions | undefined, proxy?: string): ExtractOptions {
		const merged = host.extractOptions ? { ...(options ?? {}), ...host.extractOptions } : options;
		return withRegisteredFetchOptions(merged, registeredToolNames, proxy);
	}

	function storeFetchResult(
		responseId: string,
		data: FetchedContentData,
		authProfile?: AuthFetchProfile,
	): boolean {
		if (authProfile?.cache === "off") return false;
		host.storeFetchedContent(responseId, data);
		return true;
	}

	function storeAndPublishSearch(results: QueryResultData[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id,
			type: "search",
			timestamp: Date.now(),
			queries: results,
		};
		storeResult(id, data);
		host.publishResult?.(data);
		return id;
	}

	function buildSearchReturn(opts: SearchReturnOptions): WebToolResult {
		const sc = opts.results.filter((r) => !r.error).length;
		const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

		const hasApprovedSummary =
			typeof opts.approvedSummary === "string" && opts.approvedSummary.trim().length > 0;
		const maxInlineContentChars = settings.maxInlineContentChars;
		let output = "";
		if (hasApprovedSummary) {
			output = opts.approvedSummary?.trim() ?? "";
		} else {
			if (opts.curated) {
				output +=
					"[These results were manually curated by the user in the browser. Use them as-is — do not re-search or discard.]\n\n";
			}
			const providerNames = opts.results.map((result) => {
				const providers = result.providers ?? (result.provider ? [result.provider] : []);
				return providers.join(", ") || "unknown";
			});
			output +=
				opts.results.length === 1
					? `**Provider:** ${providerNames[0]}\n\n`
					: `**Providers used:** ${providerNames.map((name, index) => `Query ${index + 1}: ${name}`).join("; ")}\n\n`;
			const duplicateQueries = opts.curated ? duplicateQuerySet(opts.results) : new Set<string>();
			for (const { query, answer, results, error, provider } of opts.results) {
				if (opts.queryList.length > 1) {
					output += opts.curated
						? formatQueryHeader(query, provider, duplicateQueries)
						: `## Query: "${query}"\n\n`;
				}
				if (error) output += `Error: ${error}\n\n`;
				else output += `${formatSearchSummary(results, answer)}\n\n`;
			}
		}

		const hasInlineReady = hasFullInlineCoverage(opts.urls, opts.inlineContent);
		let fetchId: string | null = null;
		if (hasInlineReady && opts.inlineContent) {
			fetchId = generateId();
			const data = {
				id: fetchId,
				type: "fetch",
				timestamp: Date.now(),
				urls: opts.inlineContent,
			} satisfies FetchedContentData;
			host.storeFetchedContent(fetchId, data);
		} else if (opts.includeContent) {
			fetchId = host.startBackgroundFetch?.(opts.urls, opts.proxy, opts.inlineContent) ?? null;
		}

		const searchId = storeAndPublishSearch(opts.results);
		const isBackgroundFetch = fetchId !== null && !hasInlineReady;
		const unboundedPresentation = output.trim();
		const buildGuidance = (forTruncation: boolean): string => {
			let value = "";
			if (hasInlineReady && opts.inlineContent && fetchId) {
				value += `\n---\nFull content for ${opts.inlineContent.length} sources is ready as responseId "${fetchId}". `;
				value += getSearchContentEnabled
					? `Use ${toolNames.getSearchContent}({ responseId: "${fetchId}", urlIndex: 0, offset: 0, limit: ${maxInlineContentChars} }) to retrieve the first bounded page.`
					: forTruncation
						? `Enable ${toolNames.getSearchContent} to retrieve the full stored content.`
						: "";
			} else if (isBackgroundFetch && fetchId) {
				value += `\n---\nContent fetching in background as responseId "${fetchId}". Will notify when ready.`;
			}
			if (getSearchContentEnabled || forTruncation) {
				value += `\n---\nFull search results are stored as responseId "${searchId}". `;
				value += getSearchContentEnabled
					? `Use ${toolNames.getSearchContent}({ responseId: "${searchId}", queryIndex: 0, offset: 0, limit: ${maxInlineContentChars} }) to retrieve the first bounded page${opts.results.length > 1 ? `; repeat with queryIndex 1 through ${opts.results.length - 1}` : ""}.`
					: `Enable ${toolNames.getSearchContent} to retrieve the full stored results.`;
			}
			return value;
		};
		const presentation = hasApprovedSummary
			? {
					text: unboundedPresentation,
					truncated: false,
					originalChars: unboundedPresentation.length,
					returnedChars: unboundedPresentation.length,
					omittedChars: 0,
				}
			: boundSearchPresentation(
					unboundedPresentation,
					buildGuidance(false),
					buildGuidance(true),
					maxInlineContentChars,
				);

		const summaryGuidance = hasApprovedSummary ? buildGuidance(false) : "";
		return {
			content: [
				{ type: "text", text: presentation.text },
				...(summaryGuidance ? [{ type: "text" as const, text: summaryGuidance }] : []),
			],
			structuredContent: searchStructuredContent(searchId, fetchId, opts.results),
			details: {
				queries: opts.queryList,
				queryCount: opts.queryList.length,
				successfulQueries: sc,
				totalResults: tr,
				includeContent: opts.includeContent,
				fetchId,
				fetchUrls: isBackgroundFetch ? opts.urls : undefined,
				searchId,
				queryProviders: opts.results.map((result) => ({
					query: result.query,
					providers: result.providers ?? (result.provider ? [result.provider] : []),
				})),
				truncated: presentation.truncated,
				originalChars: presentation.originalChars,
				returnedChars: presentation.returnedChars,
				omittedChars: presentation.omittedChars,
				...(opts.curated
					? {
							curated: true,
							curatedFrom: opts.curatedFrom,
							curatedQueries: opts.results.map((r) => ({
								query: r.query,
								provider: r.provider || null,
								answer: r.answer || null,
								sources: r.results.map((s) => ({ title: s.title, url: s.url })),
								error: r.error,
							})),
						}
					: {}),
				...(opts.workflow && hasApprovedSummary
					? {
							summary: {
								text: opts.approvedSummary?.trim(),
								workflow: opts.workflow,
								model: opts.summaryMeta?.model ?? null,
								durationMs: opts.summaryMeta?.durationMs ?? 0,
								tokenEstimate: opts.summaryMeta?.tokenEstimate ?? 0,
								fallbackUsed: opts.summaryMeta?.fallbackUsed === true,
								fallbackReason: opts.summaryMeta?.fallbackReason,
								phase: opts.summaryMeta?.phase,
								edited: opts.summaryMeta?.edited === true,
							},
						}
					: {}),
			},
		};
	}

	async function webSearch(
		params: WebSearchParams,
		signal?: AbortSignal,
		call: WebSearchCallOptions = {},
	): Promise<WebToolResult> {
		const { extensionContext: ctx, onUpdate } = call;
		return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
			const rawQueryList: unknown[] = Array.isArray(params.queries)
				? params.queries
				: params.query !== undefined
					? expandQueryString(params.query)
					: [];
			const queryList = normalizeQueryList(rawQueryList);
			const recencyFilter = normalizeRecencyFilter(params.recencyFilter);

			if (queryList.length === 0) {
				return {
					content: [
						{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." },
					],
					details: { error: "No query provided" },
				};
			}

			let completedSearches = 0;
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];
			const resolvedProvider = resolveRequestedProvider(params.provider);
			const providerFromConfig = (normalizeProviderInput(params.provider) ?? "auto") === "auto";

			const queryResponses = await runSearchQueries(queryList, async (query) => {
				signal?.throwIfAborted();
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Searching "${query}" (${completedSearches}/${queryList.length} complete)...`,
						},
					],
					details: {
						phase: "search",
						progress: completedSearches / queryList.length,
						currentQuery: query,
					},
				});

				try {
					const { answer, results, inlineContent, provider, providerResponses } = await search(
						query,
						{
							provider: resolvedProvider,
							providerFromConfig,
							numResults: params.numResults,
							recencyFilter,
							domainFilter: params.domainFilter,
							includeContent: params.includeContent,
							category: params.category,
							signal,
							extensionContext: ctx,
						},
					);

					const providers = providerResponses?.map((response) => response.provider) ?? [provider];
					return {
						result: {
							query,
							answer,
							results,
							error: null,
							provider,
							providers,
						} satisfies QueryResultData,
						inlineContent,
					};
				} catch (err) {
					if (signal?.aborted || isAbortError(err)) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const requestedProvider = toCuratorProvider(resolvedProvider);
					return {
						result: {
							query,
							answer: "",
							results: [],
							error: message,
							provider: requestedProvider,
						} satisfies QueryResultData,
						inlineContent: undefined,
					};
				} finally {
					completedSearches++;
					if (!signal?.aborted) {
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `Completed ${completedSearches}/${queryList.length} searches.`,
								},
							],
							details: {
								phase: "search",
								progress: completedSearches / queryList.length,
								currentQuery: query,
							},
						});
					}
				}
			});
			const searchResults = queryResponses.map((response) => response.result);
			for (const response of queryResponses) {
				for (const result of response.result.results) {
					if (!allUrls.includes(result.url)) allUrls.push(result.url);
				}
				if (response.inlineContent) allInlineContent.push(...response.inlineContent);
			}

			let approvedSummary: string | undefined;
			let summaryMeta: SummaryMeta | undefined;
			if (call.summarize) {
				const summary = await call.summarize(searchResults);
				if ("content" in summary) return summary;
				approvedSummary = summary.approvedSummary;
				summaryMeta = summary.summaryMeta;
			}

			let inlineContent = allInlineContent.length > 0 ? allInlineContent : undefined;
			if (
				params.includeContent &&
				(call.awaitContent || !host.startBackgroundFetch) &&
				allUrls.length > 0 &&
				!hasFullInlineCoverage(allUrls, inlineContent)
			) {
				// Hosts without background notifications, and calls that ask to, wait for the same page fetch instead.
				const proxy = typeof params.proxy === "string" ? params.proxy : undefined;
				const fetched = await fetchUncoveredContent(allUrls, inlineContent, (urls) =>
					fetchAllContent(urls, signal, fetchOptions(undefined, proxy)),
				);
				signal?.throwIfAborted();
				inlineContent = stripThumbnails(fetched);
			}

			return buildSearchReturn({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent,
				workflow: call.summarize ? "auto-summary" : undefined,
				approvedSummary,
				summaryMeta,
				proxy: typeof params.proxy === "string" ? params.proxy : undefined,
			});
		});
	}

	async function sourceCheck(
		params: SourceCheckParams,
		signal?: AbortSignal,
		call: WebToolCallOptions = {},
	): Promise<WebToolResult> {
		const ctx = call.extensionContext;
		return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
			const claim = typeof params.claim === "string" ? params.claim.trim() : "";
			if (!claim) {
				return {
					content: [{ type: "text", text: "Error: 'claim' is required." }],
					details: { error: "Missing claim" },
				};
			}

			const requestedQueries = Array.isArray(params.queries)
				? params.queries
						.filter((query): query is string => typeof query === "string")
						.map((query) => query.trim())
						.filter(Boolean)
				: [];
			const queries = (requestedQueries.length > 0 ? requestedQueries : [claim]).slice(0, 8);
			const numResults =
				typeof params.numResults === "number" && Number.isFinite(params.numResults)
					? Math.min(20, Math.max(1, Math.floor(params.numResults)))
					: 5;
			const domainFilter = Array.isArray(params.domainFilter)
				? params.domainFilter.filter((domain): domain is string => typeof domain === "string")
				: undefined;
			const recencyFilter = normalizeRecencyFilter(params.recencyFilter);
			const resultsByUrl = new Map<string, SearchResult>();
			const summaries: string[] = [];
			const errors: Array<{ query: string; error: string }> = [];
			let provider: string | undefined;

			for (const query of queries) {
				if (signal?.aborted) break;
				try {
					const response = await search(query, {
						provider: resolveRequestedProvider(params.provider),
						providerFromConfig: (normalizeProviderInput(params.provider) ?? "auto") === "auto",
						numResults,
						recencyFilter,
						domainFilter,
						signal,
						extensionContext: ctx,
					});
					if (signal?.aborted) break;
					provider ??= response.provider;
					if (response.answer) summaries.push(`${query}: ${response.answer}`);
					for (const result of response.results) {
						if (!resultsByUrl.has(result.url)) resultsByUrl.set(result.url, result);
					}
				} catch (err) {
					if (signal?.aborted || isAbortError(err)) break;
					errors.push({ query, error: err instanceof Error ? err.message : String(err) });
				}
			}

			const results = [...resultsByUrl.values()]
				.slice(0, 20)
				.map((result, index) => ({ ...result, rank: index + 1 }));
			let fetched: ExtractedContent[] = [];
			if (params.fetchContent && results.length > 0) {
				const urls = results.slice(0, 5).map((result) => result.url);
				try {
					fetched = await fetchAllContent(
						urls,
						signal,
						fetchOptions(undefined, typeof params.proxy === "string" ? params.proxy : undefined),
					);
				} catch (err) {
					if (signal?.aborted || isAbortError(err)) throw err;
					fetched = urls.map((url) => ({
						url,
						title: "",
						content: "",
						error: err instanceof Error ? err.message : String(err),
					}));
				}
			}
			const artifact = withClaimAssessment(
				buildResearchArtifact({
					query: claim,
					provider,
					summary: summaries.length > 0 ? summaries.join("\n\n") : undefined,
					results,
					fetched,
					recency: recencyFilter,
					domainFilter,
				}),
				[claim],
			);
			if (errors.length > 0) artifact.errors = errors;
			storeResearchArtifact(artifact);
			host.publishResult?.({
				id: artifact.id,
				type: "research",
				timestamp: artifact.timestamp,
				artifact,
			});
			return {
				content: [
					{
						type: "text",
						text: formatSourceCheckResult(
							artifact,
							getSearchContentEnabled ? toolNames.getSearchContent : null,
						),
					},
				],
				details: {
					responseId: artifact.id,
					artifact,
					sourceCount: artifact.sources.length,
					passageCount: artifact.passages.length,
					searchCount: queries.length,
				},
			};
		});
	}

	/** Answers each fetched page; a page that cannot be answered keeps the fetch error shape. */
	async function answerFetchedPages(
		fetchResults: ExtractedContent[],
		options: NormalizedFetchContentParams["options"],
		ctx: ExtensionContext | undefined,
		signal?: AbortSignal,
	): Promise<ExtractedContent[]> {
		return Promise.all(
			fetchResults.map(async (result) => {
				if (result.error) return result;
				// Reject image-as-payload results (direct images, video frames — they
				// set mimeType and/or frames). A text result that merely attaches a
				// thumbnail (YouTube analysis) stays answerable.
				if (result.mimeType?.startsWith("image/") || result.frames?.length) {
					return { ...result, error: "Page answer requires textual fetched content" };
				}
				try {
					if (!host.answerFromPage) throw new Error("this host cannot answer from fetched pages");
					const answer = await host.answerFromPage(
						{
							question: options.prompt ?? "",
							pageText: result.content,
							sourceUrl: result.url,
							...(options.answerModel ? { model: options.answerModel } : {}),
						},
						ctx,
						signal,
					);
					return { ...result, content: answer.text };
				} catch (err) {
					return {
						...result,
						error: `Page answer failed: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			}),
		);
	}

	function extractionRequestOptions(
		mode: FetchMode,
		options: NormalizedFetchContentParams["options"],
		authFetchProfile: AuthFetchProfile | undefined,
	): ExtractOptions {
		const { answerModel: _answerModel, auth: _auth, ...extractionOptions } = { ...options, mode };
		const { prompt: _prompt, ...answerExtractionOptions } = extractionOptions;
		return fetchOptions(
			{
				...(mode === "answer" ? answerExtractionOptions : extractionOptions),
				...(authFetchProfile ? { authFetchProfile } : {}),
			},
			options.proxy,
		);
	}

	async function fetchContent(
		params: FetchContentToolParams,
		signal?: AbortSignal,
		call: WebToolCallOptions = {},
	): Promise<WebToolResult> {
		const { extensionContext: ctx, onUpdate } = call;
		let request: FetchRequest;
		try {
			request = resolveFetchRequest(params, fetchModeConfig);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
		}
		const { urlList, mode, options } = request;
		let authFetchProfile: AuthFetchProfile | undefined;
		if (options.auth !== undefined) {
			try {
				authFetchProfile = resolveAuthFetchProfile(options.auth);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
			}
		}
		return runWithProxy(options.proxy, async () => {
			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
				details: { phase: "fetch", progress: 0 },
			});
			// Answers are generated for display; the original pages are what get stored, so the
			// auth fetch cache policy applies to the stored content, never to the presentation.
			const fetchResults = await fetchAllContent(
				urlList,
				signal,
				extractionRequestOptions(mode, options, authFetchProfile),
			);
			const presentedResults =
				mode === "answer"
					? await answerFetchedPages(fetchResults, options, ctx, signal)
					: fetchResults;

			const responseId = generateId();
			const storedContent = storeFetchResult(
				responseId,
				{
					id: responseId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetchResults),
				} satisfies FetchedContentData,
				authFetchProfile,
			);
			const storedResponseId = storedContent ? responseId : null;
			const presentation: FetchPresentation = {
				mode,
				getSearchContentTool: getSearchContentEnabled ? toolNames.getSearchContent : null,
				responseId: storedResponseId,
				maxChars: getMaxInlineContentChars(),
				urlList,
				structuredContent: fetchStructuredContent(storedResponseId, presentedResults),
			};
			return urlList.length === 1
				? presentSingleFetch(presentation, presentedResults[0], params)
				: presentFetchedUrls(presentation, presentedResults);
		});
	}

	function storedContentError(text: string, details: Record<string, unknown>): WebToolResult {
		return { content: [{ type: "text", text }], details };
	}

	/** One page of stored content: the requested window plus the output ceiling the
	 * continuation hint has to fit into. */
	interface StoredContentPage {
		offset: number;
		limit: number;
		maxChars: number;
	}

	/** What get_search_content selected out of a stored result. Searching and paging only
	 * need the text, the labels the messages use, and the details the result carries; they
	 * never care which tool stored it. */
	interface StoredContentSelection {
		text: string;
		details: Record<string, unknown>;
		errorDetails: Record<string, unknown>;
		/** Names the selection in offset and limit messages. */
		target: string;
		/** Names the selection in out-of-range messages. */
		rangeTarget: string;
		/** Names the selection in find errors. */
		findTarget: string;
		/** Shown before found text (the fetch page heading). */
		heading?: string;
		renderPage(page: StoredContentPage): { text: string; endOffset: number };
	}

	/** Selectors return either the selection or the tool result explaining why it is unavailable. */
	function isToolResult<T extends object>(value: T | WebToolResult): value is WebToolResult {
		return "content" in value;
	}

	function selectResearchArtifact(
		params: GetSearchContentParams,
	): StoredContentSelection | WebToolResult {
		const artifact = getResearchArtifact(params.responseId);
		if (!artifact)
			return storedContentError(
				`Error: stored research artifact for responseId ${formatInputValue(params.responseId)} was not found. Use a responseId returned by ${storedContentSources}.`,
				{ error: "Artifact not found", responseId: params.responseId },
			);
		const text = JSON.stringify(artifact, null, 2);
		const target = `responseId ${formatInputValue(params.responseId)}`;
		return {
			text,
			details: { responseId: artifact.id, type: "research", contentLength: text.length },
			errorDetails: { responseId: params.responseId, type: "research" },
			target,
			rangeTarget: target,
			findTarget: `research artifact for ${target}`,
			renderPage: ({ offset, limit, maxChars }) => {
				const page = sliceWithContinuation(
					text,
					offset,
					limit,
					maxChars,
					(end) =>
						`\n\n---\nShowing chars ${offset}-${end} of ${text.length}. Use ${toolNames.getSearchContent}({ responseId: "${artifact.id}", offset: ${end}, limit: ${limit} }) for the next slice.`,
				);
				return { text: page.text, endOffset: page.endOffset };
			},
		};
	}

	/** Resolves the query or queryIndex a call names, or the error explaining why it cannot. */
	function resolveStoredQuery(
		params: GetSearchContentParams,
		queries: QueryResultData[],
	): { index: number; entry: QueryResultData } | WebToolResult {
		const indexed = queries.map((entry, index) => `${index}: "${entry.query}"`).join(", ");
		if (params.query !== undefined) {
			const index = queries.findIndex((entry) => entry.query === params.query);
			const entry = queries[index];
			if (!entry)
				return storedContentError(
					`Query ${formatInputValue(params.query)} was not found for responseId ${formatInputValue(params.responseId)}. Received query=${formatInputValue(params.query)}. Available queries: ${queries.map((candidate) => `"${candidate.query}"`).join(", ") || "none"}. Use one of the available queries or queryIndex.`,
					{ error: "Query not found" },
				);
			return { index, entry };
		}
		if (params.queryIndex !== undefined) {
			const entry = queries[params.queryIndex];
			if (!entry)
				return storedContentError(
					`Query index ${formatInputValue(params.queryIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received queryIndex=${formatInputValue(params.queryIndex)}; valid indexes are 0-${queries.length - 1}. Available queries: ${indexed || "none"}. Use one of the available indexes.`,
					{ error: "Index out of range" },
				);
			return { index: params.queryIndex, entry };
		}
		return storedContentError(
			`Specify query or queryIndex for responseId ${formatInputValue(params.responseId)}. Available queries: ${indexed || "none"}.`,
			{ error: "No query specified" },
		);
	}

	function selectSearchQuery(
		params: GetSearchContentParams,
		queries: QueryResultData[],
	): StoredContentSelection | WebToolResult {
		const resolved = resolveStoredQuery(params, queries);
		if (isToolResult(resolved)) return resolved;
		const { index, entry } = resolved;
		if (entry.error)
			return storedContentError(
				`Error retrieving query ${formatInputValue(entry.query)} from responseId ${formatInputValue(params.responseId)}: ${entry.error}. Check the stored search result and retry with another query or queryIndex if needed.`,
				{ error: entry.error, query: entry.query },
			);
		const text = formatFullResults(entry);
		const target = `query ${formatInputValue(entry.query)}`;
		return {
			text,
			details: {
				responseId: params.responseId,
				query: entry.query,
				resultCount: entry.results.length,
				contentLength: text.length,
			},
			errorDetails: { query: entry.query },
			target,
			rangeTarget: `${target} in responseId ${formatInputValue(params.responseId)}`,
			findTarget: `${target} for responseId ${formatInputValue(params.responseId)}`,
			renderPage: ({ offset, limit, maxChars }) => {
				const page = sliceWithContinuation(
					text,
					offset,
					limit,
					maxChars,
					(end) =>
						`\n\n---\nShowing chars ${offset}-${end} of ${text.length}. Use ${toolNames.getSearchContent}({ responseId: "${params.responseId}", queryIndex: ${index}, offset: ${end}, limit: ${limit} }) for the next slice.`,
				);
				return { text: page.text, endOffset: page.endOffset };
			},
		};
	}

	/** Resolves the url or urlIndex a call names, or the error explaining why it cannot. */
	function resolveStoredUrl(
		params: GetSearchContentParams,
		urls: ExtractedContent[],
	): { index: number; entry: ExtractedContent } | WebToolResult {
		const indexed = urls.map((entry, index) => `${index}: ${entry.url}`).join("\n  ");
		if (params.url !== undefined) {
			const index = urls.findIndex((entry) => entry.url === params.url);
			const entry = urls[index];
			if (!entry)
				return storedContentError(
					`URL ${formatInputValue(params.url)} was not found for responseId ${formatInputValue(params.responseId)}. Received url=${formatInputValue(params.url)}. Available URLs:\n  ${urls.map((candidate) => candidate.url).join("\n  ") || "  none"}\nUse one of the available URLs or urlIndex.`,
					{ error: "URL not found" },
				);
			return { index, entry };
		}
		if (params.urlIndex !== undefined) {
			const entry = urls[params.urlIndex];
			if (!entry)
				return storedContentError(
					`URL index ${formatInputValue(params.urlIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received urlIndex=${formatInputValue(params.urlIndex)}; valid indexes are 0-${urls.length - 1}. Available URLs:\n  ${indexed}\nUse one of the available indexes.`,
					{ error: "Index out of range" },
				);
			return { index: params.urlIndex, entry };
		}
		// A single stored URL is the obvious target, so calls that omit url and urlIndex
		// (common with findText on single-URL fetches) succeed without a retry.
		if (urls.length === 1 && urls[0]) return { index: 0, entry: urls[0] };
		return storedContentError(
			`Specify url or urlIndex for responseId ${formatInputValue(params.responseId)}. Available URLs:\n  ${indexed}`,
			{ error: "No URL specified" },
		);
	}

	function selectFetchUrl(
		params: GetSearchContentParams,
		urls: ExtractedContent[],
	): StoredContentSelection | WebToolResult {
		const resolved = resolveStoredUrl(params, urls);
		if (isToolResult(resolved)) return resolved;
		const { index, entry } = resolved;
		if (entry.error)
			return storedContentError(
				`Error retrieving URL ${formatInputValue(entry.url)} from responseId ${formatInputValue(params.responseId)}: ${entry.error}. Check the stored fetch result and retry with another URL or urlIndex if needed.`,
				{ error: entry.error, url: entry.url },
			);
		const content = entry.content;
		const heading = `# ${entry.title || entry.url}\n\n`;
		const target = `URL ${formatInputValue(entry.url)}`;
		const inResponse = `${target} in responseId ${formatInputValue(params.responseId)}`;
		return {
			text: content,
			heading,
			details: { url: entry.url, title: entry.title, contentLength: content.length },
			errorDetails: { url: entry.url },
			target,
			rangeTarget: inResponse,
			findTarget: `${target} for responseId ${formatInputValue(params.responseId)}`,
			renderPage: ({ offset, limit }) => {
				const endOffset = pageEnd(content, offset, Math.min(offset + limit, content.length));
				const hasMore = endOffset < content.length;
				let text = `${heading}${content.slice(offset, endOffset)}`;
				if (hasMore || offset > 0) {
					text += `\n\n---\nShowing chars ${offset}-${endOffset} of ${content.length}.`;
					if (hasMore)
						text += ` Use ${toolNames.getSearchContent}({ responseId: "${params.responseId}", urlIndex: ${index}, offset: ${endOffset}, limit: ${limit} }) for the next slice.`;
				}
				return { text, endOffset };
			},
		};
	}

	function selectStoredContent(
		params: GetSearchContentParams,
		data: StoredSearchData,
	): StoredContentSelection | WebToolResult {
		if (data.type === "research") return selectResearchArtifact(params);
		if (data.type === "search" && data.queries) return selectSearchQuery(params, data.queries);
		if (data.type === "fetch" && data.urls) return selectFetchUrl(params, data.urls);
		return storedContentError(
			`Invalid stored data for responseId ${formatInputValue(params.responseId)}: received type ${formatInputValue(data.type)}. Use a responseId returned by ${storedContentSources}.`,
			{ error: "Invalid data" },
		);
	}

	/** Finds or pages the selected content; every stored result shape shares this step. */
	function readStoredContent(
		params: GetSearchContentParams,
		selection: StoredContentSelection,
	): WebToolResult {
		const maxInlineContentChars = settings.maxInlineContentChars;
		if (params.findText !== undefined) {
			const findMode = params.findMode ?? "case-insensitive";
			try {
				const { text, ...findDetails } = findContent(
					selection.text,
					normalizeFindQueries(params.findText),
					findMode,
				);
				return {
					content: [{ type: "text", text: `${selection.heading ?? ""}${text}` }],
					details: { ...selection.details, findMode, ...findDetails },
				};
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				return storedContentError(
					`Unable to find ${formatInputValue(params.findText)} in ${selection.findTarget}: ${error}. Check findText and use a supported findMode.`,
					{ error, ...selection.errorDetails },
				);
			}
		}
		const offset = params.offset ?? 0;
		const limit = params.limit ?? maxInlineContentChars;
		if (!Number.isInteger(offset) || offset < 0)
			return storedContentError(
				`Invalid offset: received ${formatInputValue(offset)} for ${selection.target}; offset must be a non-negative integer. Use 0 or a larger integer.`,
				{ error: "Invalid offset", offset },
			);
		if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars)
			return storedContentError(
				`Invalid limit: received ${formatInputValue(limit)} for ${selection.target}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.`,
				{ error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
			);
		if (offset > selection.text.length)
			return storedContentError(
				`Offset ${offset} is out of range for ${selection.rangeTarget}. Received offset ${offset}; valid range is 0-${selection.text.length}. Use an offset within that range.`,
				{ error: "Offset out of range", offset, contentLength: selection.text.length },
			);
		const { text, endOffset } = selection.renderPage({
			offset,
			limit,
			maxChars: maxInlineContentChars,
		});
		const hasMore = endOffset < selection.text.length;
		return {
			content: [{ type: "text", text }],
			details: {
				...selection.details,
				offset,
				limit,
				returnedChars: endOffset - offset,
				nextOffset: hasMore ? endOffset : null,
				truncated: hasMore,
			},
		};
	}

	async function getSearchContent(rawParams: RawGetSearchContentParams): Promise<WebToolResult> {
		const params = normalizeGetSearchContentParams(rawParams);
		if (params.findMode !== undefined && params.findText === undefined)
			return storedContentError(
				`findMode ${formatInputValue(params.findMode)} requires findText; provide findText or omit findMode.`,
				{ error: "findMode requires findText" },
			);
		const data = getResult(params.responseId);
		if (!data)
			return storedContentError(
				`Error: No stored results for responseId ${formatInputValue(params.responseId)}. Use a responseId returned by ${storedContentSources}.`,
				{ error: "Not found", responseId: params.responseId },
			);
		const selection = selectStoredContent(params, data);
		return isToolResult(selection) ? selection : readStoredContent(params, selection);
	}

	return {
		webSearch,
		fetchContent,
		getSearchContent,
		sourceCheck,
		buildSearchReturn,
	};
}

// Marks a final tool result as failed (`isError: true`) for both the Pi tools
// and the MCP server. A result with details.error is an error, and so is a call
// where nothing requested succeeded: every web_search query, every fetch_content
// URL, or every source_check search failed. A working search with zero matches
// is not.
export function markToolError<T extends Omit<WebToolResult, "structuredContent">>(result: T): T {
	const { error, queryCount, successfulQueries, urlCount, successful, searchCount, artifact } =
		result.details;
	const nothingSucceeded =
		(typeof queryCount === "number" && queryCount > 0 && successfulQueries === 0) ||
		(typeof urlCount === "number" && urlCount > 0 && successful === 0) ||
		(typeof searchCount === "number" &&
			searchCount > 0 &&
			(artifact as ResearchArtifact).errors?.length === searchCount);
	return error !== undefined || nothingSucceeded ? { ...result, isError: true } : result;
}
