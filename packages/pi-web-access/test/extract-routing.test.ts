import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtractedContent } from "../src/extract.ts";

// extractContent is the routing policy: safety/config gates, special sources
// (video, GitHub, YouTube), the HTTP gate, provider fallback in configured
// order, then final diagnostics. These tests pin that policy against stubs, so
// the provider table can be restructured without changing routing behavior.

const h = vi.hoisted(() => {
	const calls: string[] = [];
	const stub = (name: string, matches: (url: string) => boolean = () => true) => {
		const state: { result: unknown; error: unknown; enabled: boolean; args?: unknown[] } = {
			result: null,
			error: undefined,
			enabled: true,
		};
		const extract = vi.fn(async (url: string, ...args: unknown[]) => {
			if (!matches(url)) return null;
			calls.push(name);
			state.args = args;
			if (state.error !== undefined) throw state.error;
			return state.result;
		});
		return { state, extract };
	};
	const isGitHub = (url: string) => /^https:\/\/github\.com\//.test(url);
	const isYouTube = (url: string) => /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url);
	return {
		calls,
		http: vi.fn(),
		firecrawl: stub("firecrawl"),
		crawl4ai: stub("crawl4ai"),
		tinyfish: stub("tinyfish"),
		search1api: stub("search1api"),
		querit: stub("querit"),
		kagi: stub("kagi"),
		ollama: stub("ollama"),
		parallel: stub("parallel"),
		parallelMcp: stub("parallel-mcp"),
		brightdata: stub("brightdata"),
		deepseek: stub("deepseek"),
		geminiUrlContext: stub("gemini-url-context"),
		geminiWeb: stub("gemini-web"),
		github: stub("github", isGitHub),
		githubIssuePr: stub(
			"github-issue-pr",
			(url) => isGitHub(url) && /\/(issues|pull)\/\d+/.test(url),
		),
		youtube: stub("youtube", isYouTube),
	};
});

vi.mock("../src/ssrf-protection.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/ssrf-protection.ts")>()),
	fetchRemoteUrl: h.http,
}));
vi.mock("../src/firecrawl.ts", () => ({
	isFirecrawlAvailable: () => h.firecrawl.state.enabled,
	extractWithFirecrawl: h.firecrawl.extract,
}));
vi.mock("../src/crawl4ai.ts", () => ({
	isCrawl4aiAvailable: () => h.crawl4ai.state.enabled,
	extractWithCrawl4ai: h.crawl4ai.extract,
}));
vi.mock("../src/tinyfish.ts", () => ({
	isTinyFishAvailable: () => h.tinyfish.state.enabled,
	extractWithTinyFish: h.tinyfish.extract,
}));
vi.mock("../src/search1api.ts", () => ({
	isSearch1APIAvailable: () => h.search1api.state.enabled,
	extractWithSearch1API: h.search1api.extract,
}));
vi.mock("../src/querit.ts", () => ({
	isQueritAvailable: () => h.querit.state.enabled,
	extractWithQuerit: h.querit.extract,
}));
vi.mock("../src/kagi.ts", () => ({
	isKagiExtractAvailable: () => h.kagi.state.enabled,
	extractWithKagi: h.kagi.extract,
}));
vi.mock("../src/ollama.ts", () => ({
	isOllamaFetchAvailable: () => h.ollama.state.enabled,
	extractWithOllama: h.ollama.extract,
}));
vi.mock("../src/parallel.ts", () => ({
	isParallelAvailable: () => h.parallel.state.enabled,
	extractWithParallel: h.parallel.extract,
}));
vi.mock("../src/parallel-mcp.ts", () => ({
	extractWithParallelMcp: h.parallelMcp.extract,
}));
vi.mock("../src/brightdata-unlocker.ts", () => ({
	isBrightDataUnlockerAvailable: () => h.brightdata.state.enabled,
	extractWithBrightDataUnlocker: h.brightdata.extract,
}));
vi.mock("../src/deepseek.ts", () => ({
	isDeepSeekAvailable: () => h.deepseek.state.enabled,
	extractWithDeepSeek: h.deepseek.extract,
}));
vi.mock("../src/gemini-url-context.ts", () => ({
	extractWithUrlContext: h.geminiUrlContext.extract,
	extractWithGeminiWeb: h.geminiWeb.extract,
}));
vi.mock("../src/github-extract.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/github-extract.ts")>()),
	extractGitHub: h.github.extract,
}));
vi.mock("../src/github-issue-pr.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/github-issue-pr.ts")>()),
	extractGitHubIssuePr: h.githubIssuePr.extract,
}));
vi.mock("../src/youtube-extract.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/youtube-extract.ts")>()),
	extractYouTube: h.youtube.extract,
}));

const { extractContent } = await import("../src/extract.ts");

const PAGE_URL = "https://example.test/page";
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

function textResponse(body: string, contentType = "text/plain"): Response {
	return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

function page(name: string): ExtractedContent {
	return { url: PAGE_URL, title: name, content: `${name} content`, error: null };
}

let tempDir: string;
let originalAgentDir: string | undefined;

async function configure(webSearch: Record<string, unknown>): Promise<void> {
	await writeFile(join(tempDir, "ext_settings.json"), JSON.stringify({ webSearch }));
}

beforeEach(async () => {
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	tempDir = await mkdtemp(join(tmpdir(), "pi-web-access-extract-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	h.calls.length = 0;
	for (const stub of [
		h.firecrawl,
		h.crawl4ai,
		h.tinyfish,
		h.search1api,
		h.querit,
		h.kagi,
		h.ollama,
		h.parallel,
		h.parallelMcp,
		h.brightdata,
		h.deepseek,
		h.geminiUrlContext,
		h.geminiWeb,
		h.github,
		h.githubIssuePr,
		h.youtube,
	]) {
		stub.extract.mockClear();
		stub.state.result = null;
		stub.state.error = undefined;
		stub.state.enabled = true;
	}
	h.http.mockReset();
	h.http.mockResolvedValue(new Response("", { status: 500 }));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("", { status: 503 })),
	);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	await rm(tempDir, { recursive: true, force: true });
});

describe("extractContent routing", () => {
	test("default order starts with HTTP and never runs a provider after it succeeds", async () => {
		h.http.mockResolvedValue(textResponse("page body"));

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result).toMatchObject({ content: "page body", error: null });
		expect(h.http).toHaveBeenCalledTimes(1);
		expect(h.calls).toEqual([]);
	});

	test("a remote provider in front of HTTP runs the HTTP gate first", async () => {
		await configure({ fetchRouting: { providers: ["firecrawl", "http"] } });
		h.http.mockResolvedValue(textResponse("gate body"));
		h.firecrawl.state.result = page("firecrawl");

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(h.http).toHaveBeenCalledTimes(1);
		expect(h.calls).toEqual([]);
		expect(result.content).toBe("gate body");
	});

	test("a recoverable HTTP failure falls through to the configured provider", async () => {
		await configure({ fetchRouting: { providers: ["firecrawl", "http"] } });
		h.firecrawl.state.result = page("firecrawl");

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(h.http).toHaveBeenCalledTimes(1);
		expect(h.calls).toEqual(["firecrawl"]);
		expect(result.content).toBe("firecrawl content");
	});

	test("an unavailable provider is skipped without being called", async () => {
		await configure({ fetchRouting: { providers: ["http", "firecrawl", "crawl4ai"] } });
		h.firecrawl.state.enabled = false;
		h.crawl4ai.state.result = page("crawl4ai");

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(h.calls).toEqual(["crawl4ai"]);
		expect(result.content).toBe("crawl4ai content");
	});

	test("provider errors are collected into the final guidance in provider order", async () => {
		await configure({
			fetchRouting: {
				providers: ["http", "parallel", "firecrawl", "deepseek"],
				allowRemoteHostedProviders: true,
			},
		});
		h.firecrawl.state.error = new Error("firecrawl boom");
		h.deepseek.state.error = new Error("deepseek boom");
		h.parallel.state.error = new Error("parallel boom");

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(h.calls).toEqual(["parallel", "firecrawl", "deepseek"]);
		expect(result.error).toContain("Firecrawl fallback failed: firecrawl boom");
		expect(result.error).toContain("Parallel fallback failed: parallel boom");
		expect(result.error).toContain("DeepSeek fallback failed: deepseek boom");
		expect(result.error?.indexOf("Firecrawl")).toBeLessThan(result.error?.indexOf("Parallel") ?? 0);
	});

	test("a config parse error ends routing with that error", async () => {
		await configure({ fetchRouting: { providers: ["http", "firecrawl", "crawl4ai"] } });
		h.firecrawl.state.error = new Error("Failed to parse ext_settings.json: nope");

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(h.calls).toEqual(["firecrawl"]);
		expect(result.error).toBe("Failed to parse ext_settings.json: nope");
	});

	test("a credential error from Gemini ends routing", async () => {
		const { CredentialResolutionError } = await import("../src/credential-source.ts");
		await configure({
			fetchRouting: { providers: ["http", "gemini"], allowRemoteHostedProviders: true },
		});
		h.geminiUrlContext.state.error = new CredentialResolutionError("gemini", "environment-empty");
		h.geminiWeb.state.error = new CredentialResolutionError("gemini", "environment-empty");

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.error).toBe("gemini credential resolution failed: environment-empty");
	});

	test("other Gemini failures are not reported as fallback failures", async () => {
		await configure({
			fetchRouting: { providers: ["http", "gemini"], allowRemoteHostedProviders: true },
		});
		h.geminiUrlContext.state.error = new Error("gemini boom");

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.error).not.toContain("gemini boom");
		expect(result.error).toContain("Fallback options:");
	});

	test("a non-recoverable HTTP error stops before any provider", async () => {
		h.http.mockResolvedValue(
			new Response("zip", { status: 200, headers: { "content-type": "application/zip" } }),
		);

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(h.http).toHaveBeenCalledTimes(1);
		expect(h.calls).toEqual([]);
		expect(result.error).toBe("Unsupported content type: application/zip");
	});

	test("remote hosted providers stay disabled without opt-in", async () => {
		await configure({ fetchRouting: { providers: ["jina", "parallel"] } });

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(h.calls).toEqual([]);
		expect(result.error).toBe(
			"Remote hosted fetch providers are disabled unless fetchRouting.allowRemoteHostedProviders is true",
		);
	});

	test("raw mode goes straight to HTTP and skips every provider", async () => {
		await configure({ fetchRouting: { providers: ["firecrawl", "http"] } });
		h.http.mockResolvedValue(textResponse("raw body"));

		const result = await extractContent(PAGE_URL, undefined, { lookup, mode: "raw" });

		expect(h.http).toHaveBeenCalledTimes(1);
		expect(h.calls).toEqual([]);
		expect(result.content).toBe("raw body");
	});

	test("declared links from the HTTP response are appended to provider content", async () => {
		await configure({ fetchRouting: { providers: ["http", "firecrawl"] } });
		h.http.mockResolvedValue(
			new Response("<html><body></body></html>", {
				status: 200,
				headers: {
					"content-type": "text/html",
					link: '<https://example.test/feed>; rel="service-desc"',
				},
			}),
		);
		h.firecrawl.state.result = page("firecrawl");

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.content).toContain("firecrawl content");
		expect(result.content).toContain("## Declared links");
		expect(result.content).toContain("https://example.test/feed");
		expect(result.content).toContain("Service description");
	});

	test("a definitive 404 points at search instead of provider setup", async () => {
		h.http.mockResolvedValue(new Response("gone", { status: 404 }));

		const result = await extractContent(PAGE_URL, undefined, {
			lookup,
			toolNames: { webSearch: "web_search", fetchContent: "fetch_content" },
		});

		expect(result.error).toContain("does not exist (HTTP 404)");
		expect(result.error).toContain("Use web_search to find the current URL");
	});

	test("the same-origin redirect policy refuses paths whose redirects cannot be observed", async () => {
		await configure({ fetchContent: { redirects: "same-origin" } });

		const result = await extractContent("https://github.com/owner/repo", undefined, { lookup });

		expect(result.error).toContain("GitHub repository");
		expect(h.calls).toEqual([]);
	});

	test("YouTube analysis runs only when enabled and otherwise reports setup guidance", async () => {
		await configure({ youtube: { enabled: true } });
		h.youtube.state.result = null;

		const result = await extractContent("https://www.youtube.com/watch?v=abc12345678", undefined, {
			lookup,
		});

		expect(h.calls).toEqual(["youtube"]);
		expect(result.error).toContain("Could not extract YouTube video content");
	});

	test("GitHub results short-circuit before the HTTP gate", async () => {
		h.github.state.result = page("github");

		const result = await extractContent("https://github.com/owner/repo", undefined, { lookup });

		expect(h.calls).toEqual(["github"]);
		expect(result.content).toBe("github content");
	});
});
