import { createHash } from "node:crypto";
import type { KnowledgeSection, PageSectionService } from "@hheei/pi-ext-core";
import { scopeTagsForBank } from "../operations/memory-scope.js";
import type { HindsightLikeClient, ResolvedConfig } from "../types.js";

const MAX_PAGES = 32;
const MAX_PAGE_DEPTH = 8;
const MAX_SECTIONS = 128;
const MAX_SECTION_CHARS = 4_000;
const MAX_TOTAL_SECTION_CHARS = 24_000;
const MAX_PAGE_MARKDOWN_CHARS = 256_000;

interface PageDescriptor {
	readonly id: string;
	readonly name: string;
	readonly tags: readonly string[];
	readonly timestamp?: string;
	readonly stale?: boolean;
}

interface PageDocument {
	readonly id: string;
	readonly name: string;
	readonly markdown: string;
	readonly timestamp?: string;
}

interface PageCache {
	readonly version: string;
	readonly sections: readonly KnowledgeSection[];
}

export interface HindsightPageSectionServiceDeps {
	getClient(): HindsightLikeClient;
	getConfig(): ResolvedConfig;
	getProjectBankId(): string;
	getCwd(): string;
	getInjectionState(): { readonly owner: string; readonly generation?: string };
}

export interface HindsightPageSectionServiceHandle {
	readonly service: PageSectionService;
	refresh(signal: AbortSignal): Promise<void>;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function requiredText(value: unknown, field: string, maxChars: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxChars)
		throw new Error(`Hindsight knowledge page ${field} is invalid`);
	return value.trim();
}

function optionalText(value: unknown, field: string, maxChars: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requiredText(value, field, maxChars);
}

function tags(value: unknown): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 32)
		throw new Error("Hindsight knowledge page tags are invalid");
	const result = value.map((tag) => requiredText(tag, "tag", 256));
	if (new Set(result).size !== result.length)
		throw new Error("Hindsight knowledge page tags duplicate");
	return result;
}

function parsePageNode(value: unknown, depth: number, pages: PageDescriptor[]): void {
	if (depth > MAX_PAGE_DEPTH) throw new Error("Hindsight knowledge page tree is too deep");
	const node = record(value);
	if (node === undefined) throw new Error("Hindsight knowledge page tree node is invalid");
	const id = requiredText(node.id, "id", 512);
	const name = requiredText(node.name, "name", 512);
	if (node.kind !== "page" && node.kind !== "folder")
		throw new Error("Hindsight knowledge page tree node kind is invalid");
	const children = node.children;
	if (children !== undefined && !Array.isArray(children))
		throw new Error("Hindsight knowledge page tree children are invalid");
	if (node.kind === "page") {
		if (pages.length >= MAX_PAGES) throw new Error("Hindsight knowledge page count exceeds limit");
		const timestamp = optionalText(node.timestamp, "timestamp", 128);
		pages.push({
			id,
			name,
			tags: tags(node.tags),
			...(timestamp === undefined ? {} : { timestamp }),
			...(typeof node.is_stale === "boolean" ? { stale: node.is_stale } : {}),
		});
	}
	if (children !== undefined) {
		for (const child of children) parsePageNode(child, depth + 1, pages);
	}
}

function parseTree(response: unknown): readonly PageDescriptor[] {
	const root = record(response);
	if (root === undefined || !Array.isArray(root.roots))
		throw new Error("Hindsight knowledge page tree response is invalid");
	const pages: PageDescriptor[] = [];
	for (const node of root.roots) parsePageNode(node, 0, pages);
	const ids = new Set<string>();
	for (const page of pages) {
		if (ids.has(page.id)) throw new Error("Hindsight knowledge page IDs duplicate");
		ids.add(page.id);
	}
	return pages;
}

function parsePage(response: unknown, expected: PageDescriptor): PageDocument {
	const page = record(response);
	if (page === undefined) throw new Error("Hindsight knowledge page response is invalid");
	const id = requiredText(page.id, "id", 512);
	const name = requiredText(page.name, "name", 512);
	const markdown = requiredText(page.markdown, "markdown", MAX_PAGE_MARKDOWN_CHARS);
	if (id !== expected.id || name !== expected.name)
		throw new Error("Hindsight knowledge page identity mismatch");
	const timestamp = optionalText(page.timestamp, "timestamp", 128);
	return {
		id,
		name,
		markdown,
		...(timestamp === undefined ? {} : { timestamp }),
	};
}

function pageBody(markdown: string): string {
	const withoutFrontmatter = markdown.startsWith("---")
		? markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/u, "")
		: markdown;
	return withoutFrontmatter.trim();
}

function pageSections(
	page: PageDocument,
	descriptor: PageDescriptor,
	bankId: string,
	scopeTags: readonly string[],
): readonly KnowledgeSection[] {
	const body = pageBody(page.markdown);
	if (!body) return [];
	const headingPattern = /^(#{1,6})[ \t]+([^\n]+?)\s*$/gmu;
	const headings = [...body.matchAll(headingPattern)];
	const ranges =
		headings.length === 0
			? [{ heading: page.name, text: body }]
			: headings.map((match, index) => ({
					heading: (match[2] ?? "").trim(),
					text: body.slice(
						(match.index ?? 0) + match[0].length,
						headings[index + 1]?.index ?? body.length,
					),
				}));
	const pageVersion =
		page.timestamp ??
		descriptor.timestamp ??
		`sha256:${createHash("sha256").update(page.markdown).digest("hex")}`;
	return ranges
		.map((range, index): KnowledgeSection | undefined => {
			const text = range.text.trim();
			if (!range.heading || !text) return undefined;
			if (text.length > MAX_SECTION_CHARS)
				throw new Error("Hindsight knowledge page section exceeds limit");
			const id = `knowledge-page:${page.id}:section:${index}`;
			return {
				id,
				pageId: page.id,
				pageName: page.name,
				heading: range.heading,
				text,
				sourceVersion: pageVersion,
				provenance: [
					`bank:${bankId}`,
					`knowledge-page:${page.id}`,
					`page-section:${index}`,
					...(descriptor.tags.length ? [`tags:${descriptor.tags.join(",")}`] : []),
				],
				scopeTags,
				...(page.timestamp ? { updatedAt: page.timestamp } : {}),
			};
		})
		.filter((section): section is KnowledgeSection => section !== undefined);
}

async function loadCache(
	deps: HindsightPageSectionServiceDeps,
	signal: AbortSignal,
): Promise<PageCache> {
	const client = deps.getClient();
	if (client.getKnowledgePageTree === undefined || client.getKnowledgePage === undefined)
		throw new Error("Hindsight knowledge pages are unsupported by this client");
	const getPage = client.getKnowledgePage;
	signal.throwIfAborted();
	const descriptors = parseTree(
		await client.getKnowledgePageTree(deps.getProjectBankId(), { signal }),
	);
	const pages = await Promise.all(
		descriptors.map(async (descriptor) => ({
			descriptor,
			page: parsePage(
				await getPage(deps.getProjectBankId(), descriptor.id, { signal }),
				descriptor,
			),
		})),
	);
	const config = deps.getConfig();
	const bankId = deps.getProjectBankId();
	const scopeTags = scopeTagsForBank(deps.getCwd(), config, bankId);
	const sections = pages.flatMap(({ descriptor, page }) =>
		pageSections(page, descriptor, bankId, scopeTags),
	);
	if (sections.length > MAX_SECTIONS)
		throw new Error("Hindsight knowledge section count exceeds limit");
	const totalChars = sections.reduce((total, section) => total + section.text.length, 0);
	if (totalChars > MAX_TOTAL_SECTION_CHARS)
		throw new Error("Hindsight knowledge section payload exceeds limit");
	const version = `sha256:${createHash("sha256")
		.update(
			JSON.stringify({
				descriptors,
				sections: sections.map((section) => ({
					id: section.id,
					sourceVersion: section.sourceVersion,
					text: section.text,
				})),
			}),
		)
		.digest("hex")}`;
	return { version, sections };
}

/**
 * Capability probe is deliberately separate from hot-path reads. A service is
 * returned only after tree + page responses pass the pinned API validators.
 */
export async function createHindsightPageSectionService(
	deps: HindsightPageSectionServiceDeps,
	signal: AbortSignal,
): Promise<HindsightPageSectionServiceHandle | undefined> {
	if (
		deps.getClient().getKnowledgePageTree === undefined ||
		deps.getClient().getKnowledgePage === undefined
	)
		return undefined;
	let cache: PageCache;
	try {
		cache = await loadCache(deps, signal);
	} catch {
		return undefined;
	}
	let refreshInFlight: Promise<void> | undefined;
	let admittedProjectId: string | undefined;
	const refresh = async (refreshSignal: AbortSignal): Promise<void> => {
		if (refreshInFlight !== undefined) return refreshInFlight;
		const run = (async (): Promise<void> => {
			try {
				cache = await loadCache(deps, refreshSignal);
			} catch {
				// Keep last validated cache. MCTX may continue deterministic local selection.
			}
		})();
		refreshInFlight = run;
		try {
			await run;
		} finally {
			if (refreshInFlight === run) refreshInFlight = undefined;
		}
	};
	const service: PageSectionService = {
		async getPageSections({ lease, projectId, signal }) {
			signal.throwIfAborted();
			const state = deps.getInjectionState();
			if (lease.owner !== "mctx-owned" || state.owner !== "mctx-owned")
				return { kind: "unavailable", reason: "MCTX does not own knowledge injection" };
			const normalizedProjectId = projectId.trim();
			if (
				!normalizedProjectId ||
				state.generation !== lease.generation ||
				(admittedProjectId !== undefined && admittedProjectId !== normalizedProjectId)
			)
				return { kind: "unavailable", reason: "Hindsight page cache identity changed" };
			admittedProjectId ??= normalizedProjectId;
			return { kind: "sections", version: cache.version, sections: cache.sections };
		},
	};
	return { service, refresh };
}
