import type { HindsightClient, KnowledgeNode } from "@vectorize-io/hindsight-client";
import type { ResolvedHindsight } from "./config.js";
import { fingerprintTurns, type HindsightTurn, renderHindsightTranscript } from "./transcript.js";

/** One knowledge page summary as returned by knowledge tree listing. */
export interface HindsightPageSummary {
	readonly id: string;
	readonly title: string;
	readonly description?: string | undefined;
}

export interface HindsightPageList {
	readonly pages: readonly HindsightPageSummary[];
	/** False when the server reports knowledge pages as unsupported (404/405/501). */
	readonly pagesAvailable: boolean;
}

export interface HindsightPageDocument {
	readonly id: string;
	readonly title: string;
	readonly markdown: string;
}

/** One ranked page hit from the hybrid page search. */
export interface HindsightPageHit {
	readonly page: string;
	readonly pageId: string;
	readonly snippet: string;
	readonly score: number;
}

export interface HindsightRetainReceipt {
	readonly operationId: string;
	readonly documentId: string;
	readonly turns: number;
}

/**
 * The Hindsight surface this extension consumes for automatic prompt recall and writeback.
 *
 * Declared separately from the SDK adapter so lifecycle hooks can be tested
 * against a fake without a network, and so the SDK stays behind one module.
 */
export interface HindsightGateway {
	readonly bankId: string;
	listPages(signal?: AbortSignal): Promise<HindsightPageList>;
	readPage(pageId: string, signal?: AbortSignal): Promise<HindsightPageDocument>;
	searchPages(query: string, limit: number, signal?: AbortSignal): Promise<HindsightPageHit[]>;
	retainTurns(
		input: { sessionId: string; turns: readonly HindsightTurn[] },
		signal?: AbortSignal,
	): Promise<HindsightRetainReceipt>;
}

/**
 * Raised when the deployment reports that knowledge pages do not exist.
 *
 * Callers translate this into the documented degradation message instead of a raw error.
 */
export class KnowledgePagesUnavailableError extends Error {
	constructor(message = "Knowledge pages are unavailable on this Hindsight server") {
		super(message);
		this.name = "KnowledgePagesUnavailableError";
	}
}

const UNSUPPORTED_PAGE_STATUS = new Set([404, 405, 501]);

function statusCodeOf(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as { statusCode?: unknown; status?: unknown };
	for (const candidate of [record.statusCode, record.status]) {
		if (typeof candidate === "number") return candidate;
	}
	return undefined;
}

/**
 * Detects the responses a deployment without knowledge pages returns.
 *
 * The SDK surfaces the HTTP status on `statusCode` (its own errors) or `status` (a raw
 * response failure), so both are inspected.
 */
function isUnsupportedPageError(error: unknown): boolean {
	const status = statusCodeOf(error);
	return status !== undefined && UNSUPPORTED_PAGE_STATUS.has(status);
}

/**
 * The subset that means "this endpoint does not exist here".
 *
 * A 404 is deliberately excluded: on a single-page read it is far more likely to be an
 * unknown page id than a missing feature, and reporting a model's typo as "knowledge pages
 * are unavailable" would send it to the wrong fallback. A server without the feature is
 * still detected by its tree and search endpoints, which have no other reason to 404.
 */
function isMissingEndpointError(error: unknown): boolean {
	const status = statusCodeOf(error);
	return status === 405 || status === 501;
}

/** Combines caller cancellation with a per-request deadline. */
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const deadline = AbortSignal.timeout(timeoutMs);
	return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}

function pageSummaries(roots: readonly KnowledgeNode[]): HindsightPageSummary[] {
	const pages: HindsightPageSummary[] = [];
	const visit = (node: KnowledgeNode): void => {
		if (node.kind === "page") {
			pages.push({
				id: node.id,
				title: node.name,
				...(node.description ? { description: node.description } : {}),
			});
		}
		for (const child of node.children ?? []) visit(child);
	};
	for (const root of roots) visit(root);
	return pages;
}

/**
 * Wraps one SDK client in the extension's narrow gateway.
 *
 * Every call is bounded by the configured read timeout and honours the caller's
 * abort signal, so a hung server cannot hold a session open.
 */
export function createHindsightGateway(
	resolved: ResolvedHindsight,
	client: HindsightClient,
): HindsightGateway {
	const { bankId, retainTags, retainMetadata, config } = resolved;
	const read = (signal?: AbortSignal) => requestSignal(signal, config.readTimeoutMs);

	async function tree(signal: AbortSignal): Promise<KnowledgeNode[]> {
		const response = await client.getKnowledgeBaseTree(bankId, { signal });
		return response.roots;
	}

	return {
		bankId,

		async listPages(signal) {
			try {
				return { pages: pageSummaries(await tree(read(signal))), pagesAvailable: true };
			} catch (error) {
				if (isUnsupportedPageError(error)) return { pages: [], pagesAvailable: false };
				throw error;
			}
		},

		async readPage(pageId, signal) {
			try {
				const page = await client.getKnowledgePage(bankId, pageId, { signal: read(signal) });
				return { id: page.id, title: page.name, markdown: page.markdown };
			} catch (error) {
				if (isMissingEndpointError(error)) throw new KnowledgePagesUnavailableError();
				throw error;
			}
		},

		async searchPages(query, limit, signal) {
			try {
				const response = await client.searchKnowledgeBase(bankId, query, {
					limit,
					signal: read(signal),
				});
				return response.results.map((hit) => ({
					page: hit.name,
					pageId: hit.id,
					snippet: hit.snippet,
					score: hit.score,
				}));
			} catch (error) {
				if (isUnsupportedPageError(error)) throw new KnowledgePagesUnavailableError();
				throw error;
			}
		},

		async retainTurns(input, signal) {
			const turns = input.turns;
			const documentId = `pi-session-${input.sessionId}`;
			// The operation id is a pure function of the bank, session, and the exact turn
			// prefix being appended, so a resumed session re-sending the same prefix, a retry
			// after a timeout, or a duplicated agent_end all fold into one server-side retain.
			const operationId = fingerprintTurns(turns);
			await client.retain(bankId, renderHindsightTranscript(turns), {
				context: `Pi session ${input.sessionId} (branch of ${resolved.repo})`,
				documentId,
				async: true,
				operationId,
				tags: [...retainTags],
				metadata: retainMetadata,
				updateMode: "append",
				signal: read(signal),
			});
			return { operationId, documentId, turns: turns.length };
		},
	};
}

/**
 * Creates the gateway from the optional Hindsight client package.
 *
 * The SDK is imported dynamically so a disabled option never loads it, and an installation
 * without the dependency degrades to a diagnostic instead of breaking the extension.
 */
export async function openHindsightGateway(
	resolved: ResolvedHindsight,
): Promise<HindsightGateway | { error: string }> {
	try {
		const { HindsightClient } = await import("@vectorize-io/hindsight-client");
		const client = new HindsightClient({
			baseUrl: resolved.config.apiUrl,
			...(resolved.config.apiToken === undefined ? {} : { apiKey: resolved.config.apiToken }),
			userAgent: "hepi-pi-ext-memory",
		});
		return createHindsightGateway(resolved, client);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
