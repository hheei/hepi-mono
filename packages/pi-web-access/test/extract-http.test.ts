import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// extractViaHttp owns the request lifecycle (timeout, abort, activity, cleanup)
// and dispatches to raw/image/PDF/text/HTML parsing. These tests pin that
// dispatch and the markdown-negotiation retry, with the request itself stubbed.

const h = vi.hoisted(() => ({
	fetchRemoteUrl: vi.fn(),
	pdf: vi.fn(),
}));

vi.mock("../src/ssrf-protection.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/ssrf-protection.ts")>()),
	fetchRemoteUrl: h.fetchRemoteUrl,
}));
vi.mock("../src/pdf-extract.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/pdf-extract.ts")>()),
	extractPDFToMarkdown: h.pdf,
}));

const { extractContent } = await import("../src/extract.ts");

const PAGE_URL = "https://example.test/page";
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

const longParagraph = "Long readable paragraph text. ".repeat(60);
const articleHtml = `<html><head><title>Doc</title></head><body><article><h1>Doc</h1><p>${longParagraph}</p></article></body></html>`;

function response(body: string, contentType: string, init: ResponseInit = {}): Response {
	return new Response(body, {
		status: 200,
		...init,
		headers: { "content-type": contentType, ...(init.headers ?? {}) },
	});
}

let tempDir: string;
let originalAgentDir: string | undefined;

async function configure(webSearch: Record<string, unknown>): Promise<void> {
	await writeFile(join(tempDir, "ext_settings.json"), JSON.stringify({ webSearch }));
}

async function httpOnly(): Promise<void> {
	await configure({ fetchRouting: { providers: ["http"] } });
}

beforeEach(async () => {
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	tempDir = await mkdtemp(join(tmpdir(), "pi-web-access-http-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	h.fetchRemoteUrl.mockReset();
	h.pdf.mockReset();
});

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	await rm(tempDir, { recursive: true, force: true });
});

describe("raw mode", () => {
	test("returns the server representation untouched", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(response("raw body", "text/plain"));

		const result = await extractContent(PAGE_URL, undefined, { lookup, mode: "raw" });

		expect(result).toMatchObject({ content: "raw body", error: null, mimeType: "text/plain" });
		expect(h.fetchRemoteUrl.mock.calls[0]?.[1]?.headers?.Accept).toContain("text/html");
	});

	test("rejects a non-text body with a mode hint", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(response("pdf", "application/pdf"));

		const result = await extractContent(PAGE_URL, undefined, { lookup, mode: "raw" });

		expect(result.error).toBe(
			'Unsupported content type in raw mode: application/pdf; retry without mode for Markdown, or with mode "answer" and a prompt',
		);
	});
});

describe("request outcomes", () => {
	test("reports a non-ok status with its code", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(new Response("", { status: 500 }));

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.error).toContain("HTTP 500");
		expect(result.status).toBe(500);
	});

	test("rejects a declared body over the size limit", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(
			response("", "text/plain", { headers: { "content-length": String(6 * 1024 * 1024) } }),
		);

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.error).toBe("Response too large (6MB)");
	});

	test("rejects a Cloudflare interstitial served as HTTP 200", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(
			response("<html>challenge</html>", "text/html", {
				headers: { "cf-mitigated": "challenge" },
			}),
		);

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.error).toContain("Blocked by Cloudflare challenge page");
	});

	test("rejects a disabled PDF pipeline", async () => {
		await configure({ fetchRouting: { providers: ["http"] }, pdf: { enabled: false } });
		h.fetchRemoteUrl.mockResolvedValue(response("pdf", "application/pdf"));

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.error).toBe("PDF extraction is disabled by pdf.enabled");
	});

	test("extracts PDF content through the PDF pipeline", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(response("%PDF", "application/pdf"));
		h.pdf.mockResolvedValue({
			title: "Paper",
			content: "pdf markdown",
			outputPath: "/tmp/paper.md",
			pages: 3,
			chars: 42,
		});

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result).toMatchObject({
			title: "Paper",
			content: "PDF extracted and saved to: /tmp/paper.md\n\nPages: 3\nCharacters: 42",
			error: null,
		});
	});

	test("returns PDF markdown directly in answer mode", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(response("%PDF", "application/pdf"));
		h.pdf.mockResolvedValue({
			title: "Paper",
			content: "pdf markdown",
			outputPath: "/tmp/paper.md",
			pages: 3,
			chars: 42,
		});

		const result = await extractContent(PAGE_URL, undefined, { lookup, mode: "answer" });

		expect(result.content).toBe("pdf markdown");
	});

	test("rejects unsupported binary types", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(response("zip", "application/zip"));

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.error).toBe("Unsupported content type: application/zip");
	});
});

describe("images", () => {
	test("reports the host's direct-image rejection", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(response("png", "image/png"));

		const result = await extractContent(PAGE_URL, undefined, {
			lookup,
			rejectDirectImages: "no images here",
		});

		expect(result.error).toBe("no images here");
		expect(result.mimeType).toBe("image/png");
	});

	test("respects the image feature gate", async () => {
		await configure({ fetchRouting: { providers: ["http"] }, image: { enabled: false } });
		h.fetchRemoteUrl.mockResolvedValue(response("png", "image/png"));

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.error).toBe("Image fetching is disabled by image.enabled");
	});
});

describe("text and HTML parsing", () => {
	test("extracts readable HTML into markdown", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(response(articleHtml, "text/html"));

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result).toMatchObject({ title: "Doc", error: null });
		expect(result.content).toContain("Long readable paragraph text.");
	});

	test("accepts a short static page as complete", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(
			response(
				"<html><head><title>Tiny</title></head><body><article><p>tiny page</p></article></body></html>",
				"text/html",
			),
		);

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.error).toBeNull();
		expect(result.content).toContain("tiny page");
	});

	test("flags a short page that runs scripts as possibly dynamic", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(
			response(
				'<html><head><title>App</title><script src="/app.js"></script></head><body><article><p>loading</p></article></body></html>',
				"text/html",
			),
		);

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.error).toContain("runs scripts, so content may load dynamically");
	});

	test("passes markdown bodies through and records declared links", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(
			response(`# Markdown\n\n${longParagraph}`, "text/markdown", {
				headers: { link: '<https://example.test/api>; rel="service-desc"' },
			}),
		);

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.content).toContain("Long readable paragraph text.");
		expect(result.content).toContain("## Declared links");
	});
});

describe("markdown negotiation retry", () => {
	test("re-requests a short negotiated markdown body with the browser Accept header", async () => {
		await httpOnly();
		h.fetchRemoteUrl
			.mockResolvedValueOnce(response("# Short", "text/markdown"))
			.mockResolvedValueOnce(response(articleHtml, "text/html"));

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(h.fetchRemoteUrl).toHaveBeenCalledTimes(2);
		const firstAccept = h.fetchRemoteUrl.mock.calls[0]?.[1]?.headers?.Accept;
		const secondAccept = h.fetchRemoteUrl.mock.calls[1]?.[1]?.headers?.Accept;
		expect(firstAccept).toContain("text/markdown");
		expect(secondAccept).not.toContain("text/markdown");
		expect(result).toMatchObject({ title: "Doc", error: null });
		expect(result.content).toContain("Long readable paragraph text.");
	});

	test("keeps negotiated markdown when the retry yields nothing", async () => {
		await httpOnly();
		h.fetchRemoteUrl
			.mockResolvedValueOnce(response("# Short but useful", "text/markdown"))
			.mockResolvedValueOnce(new Response("", { status: 500 }));

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result.content).toContain("Short but useful");
		expect(result.error).toContain("Extracted content appears incomplete");
		expect(result.error).toContain("Browser retry failed: HTTP 500");
	});

	test("does not retry when the negotiated markdown is already substantial", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(response(`# Title\n\n${longParagraph}`, "text/markdown"));

		await extractContent(PAGE_URL, undefined, { lookup });

		expect(h.fetchRemoteUrl).toHaveBeenCalledTimes(1);
	});
});

function rscPage(articleHtmlPart: string): string {
	const payload = `1:${JSON.stringify(["$", "p", null, { children: longParagraph }])}`;
	return `<html><head><title>Flight|Site</title></head><body>${articleHtmlPart}<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`;
}

describe("RSC fallback", () => {
	test("recovers content when Readability finds no article", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(response(rscPage('<div id="root"></div>'), "text/html"));

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result).toMatchObject({ title: "Flight", error: null });
		expect(result.content).toContain("Long readable paragraph text.");
	});

	test("prefers RSC content over a short Readability result", async () => {
		await httpOnly();
		h.fetchRemoteUrl.mockResolvedValue(
			response(rscPage("<article><p>tiny page</p></article>"), "text/html"),
		);

		const result = await extractContent(PAGE_URL, undefined, { lookup });

		expect(result).toMatchObject({ title: "Flight", error: null });
		expect(result.content).toContain("Long readable paragraph text.");
		expect(result.content).not.toContain("tiny page");
	});
});
