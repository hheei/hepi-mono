import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage, setPromptSection } from "@hheei/pi-ext-core";
import { debugLog } from "../debug-log.js";
import {
	type HindsightGateway,
	type HindsightPageHit,
	type HindsightPageSummary,
	openHindsightGateway,
} from "./client.js";
import { loadHindsightConfig, type ResolvedHindsight } from "./config.js";
import { renderHindsightPreamble, renderMemoryContainer, TRUNCATION_NOTICE } from "./prompt.js";
import { HindsightRetainQueue } from "./queue.js";
import type { HindsightToolContext } from "./tools.js";
import { buildHindsightTurns } from "./transcript.js";

/** Knowledge-page hits injected before a turn when auto-recall is on. */
export const AUTO_RECALL_PAGE_LIMIT = 3;

/** What this turn actually put into the prompt, so the extension can show it to the user. */
export interface HindsightInjection {
	readonly summary: string;
	readonly pages: readonly HindsightPageHit[];
	/** True when the memory container had to be cut to the configured character budget. */
	readonly truncated: boolean;
}

/**
 * Prompt sections this extension owns. Pi diffs sections per request, so the preamble is sent
 * once and recalled facts are replaced only when they change.
 */
const PREAMBLE_SECTION = "pi-ext-memory-preamble";
const RECALL_SECTION = "pi-ext-memory-recall";

/**
 * Common short affirmation or continuation phrases that indicate the user is simply
 * continuing the conversation rather than asking a new substantive question.
 */
export const TRIVIAL_CONTINUATION_PATTERNS = new Set([
	// English affirmations & continuations
	"ok",
	"okay",
	"yes",
	"yep",
	"yeah",
	"sure",
	"go",
	"go ahead",
	"continue",
	"proceed",
	"next",
	"done",
	"carry on",
	"keep going",
	// Chinese affirmations & continuations
	"好",
	"好的",
	"行",
	"行啊",
	"可以",
	"可以的",
	"没问题",
	"没问题啊",
	"继续",
	"继续吧",
	"接着来",
	"接着说",
	"接着写",
	"下一步",
	"对",
	"对的",
	"是的",
	"恩",
	"嗯",
]);

export function isTrivialContinuation(prompt: string): boolean {
	const normalized = prompt
		.trim()
		.toLowerCase()
		.replace(/^[!?,.，。？！~\s]+|[!?,.，。？！~\s]+$/gu, "");
	return TRIVIAL_CONTINUATION_PATTERNS.has(normalized);
}

export function normalizeRecallQuery(prompt: string): string {
	return prompt.trim().toLowerCase().replace(/\s+/gu, " ");
}

interface PromptRecallResult {
	readonly text: string | undefined;
	readonly pages: readonly HindsightPageHit[];
	readonly truncated: boolean;
}

/** Result of booting the Hindsight layer for one session. */
export type HindsightStart =
	| { readonly status: "disabled" }
	| { readonly status: "ready"; readonly session: HindsightSession }
	| { readonly status: "error"; readonly error: string };

/**
 * Session-scoped Hindsight state: resolved configuration, the gateway bound to it, and the
 * ordered writeback queue.
 *
 * Owns exactly what the plan assigns to this extension: retrieving memory for the prompt
 * and writing the session's turns back. It never replaces the session's own compaction,
 * which stays owned by observational memory.
 */
export class HindsightSession {
	readonly resolved: ResolvedHindsight;
	readonly gateway: HindsightGateway;
	readonly retainQueue: HindsightRetainQueue;
	static readonly #MAX_CACHE_ENTRIES = 50;
	readonly #recallCache = new Map<string, PromptRecallResult>();
	#lastRecallResult: PromptRecallResult | undefined;
	#firstTurn = true;
	#lifecycleSignal: AbortSignal;
	#preamblePromise: Promise<string> | undefined;

	constructor(resolved: ResolvedHindsight, gateway: HindsightGateway, signal: AbortSignal) {
		this.resolved = resolved;
		this.gateway = gateway;
		this.retainQueue = new HindsightRetainQueue(gateway);
		this.#lifecycleSignal = signal;
		this.#preamblePromise = this.#renderPreamble();
	}

	/** Context handed to the tool registrations. */
	toolContext(): HindsightToolContext {
		return {
			gateway: this.gateway,
			resolved: this.resolved,
			retainQueue: this.retainQueue,
			invalidateRecallCache: () => this.invalidateRecallCache(),
		};
	}

	invalidateRecallCache(): void {
		this.#recallCache.clear();
		this.#lastRecallResult = undefined;
	}

	/**
	 * Adds long-term memory to the prompt as two named sections.
	 *
	 * The first turn of a session receives the preamble that explains the memory and its
	 * tools; later turns only receive retrieved facts, so guidance the model has already
	 * read is not paid for again. Sections are independent: a turn whose recall is
	 * unchanged sends no prompt update at all.
	 */
	async beforeAgentStart(event: BeforeAgentStartEvent): Promise<HindsightInjection | undefined> {
		if (this.#lifecycleSignal.aborted) return undefined;
		const sections = event.systemPromptOptions.sections;
		const firstTurn = this.#firstTurn;
		this.#firstTurn = false;

		const preamblePromise = firstTurn
			? (this.#preamblePromise ?? this.#renderPreamble())
			: undefined;
		this.#preamblePromise = undefined;

		const recallPromise =
			this.resolved.config.autoRecall && event.prompt.trim().length > 0
				? this.#recallForPrompt(event.prompt)
				: undefined;

		const [preamble, recalled] = await Promise.all([preamblePromise, recallPromise]);

		const summary: string[] = [];
		if (preamble !== undefined) {
			setPromptSection(sections, PREAMBLE_SECTION, preamble);
			summary.push("memory guide");
		}
		let pages: HindsightPageHit[] = [];
		let truncated = false;
		if (recalled !== undefined) {
			setPromptSection(sections, RECALL_SECTION, recalled.text);
			pages = [...recalled.pages];
			truncated = recalled.truncated;
			if (pages.length > 0)
				summary.push(`recalled ${pages.length} page${pages.length === 1 ? "" : "s"}`);
		}
		return summary.length === 0 ? undefined : { summary: summary.join(" + "), pages, truncated };
	}

	async #renderPreamble(): Promise<string> {
		let pages: HindsightPageSummary[] = [];
		let pagesAvailable = true;
		try {
			const listed = await this.gateway.listPages(this.#lifecycleSignal);
			pages = [...listed.pages];
			pagesAvailable = listed.pagesAvailable;
		} catch (error) {
			// A cold or unreachable server must not block the session; the preamble then
			// describes the memory without a page index, and tools report the real error.
			pagesAvailable = false;
			debugLog("hindsight.preamble_pages_unavailable", {
				error: errorMessage(error),
			});
		}
		return renderHindsightPreamble({
			repo: this.resolved.repo,
			bankId: this.resolved.bankId,
			isolationMode: this.resolved.isolationMode,
			pagesAvailable,
			pages,
		});
	}

	async #recallForPrompt(prompt: string): Promise<PromptRecallResult> {
		if (isTrivialContinuation(prompt)) {
			return this.#lastRecallResult ?? { text: undefined, pages: [], truncated: false };
		}

		const key = normalizeRecallQuery(prompt);
		const cached = this.#recallCache.get(key);
		if (cached !== undefined) {
			this.#lastRecallResult = cached;
			return cached;
		}

		let hits: HindsightPageHit[];
		try {
			hits = await this.gateway.searchPages(prompt, AUTO_RECALL_PAGE_LIMIT, this.#lifecycleSignal);
		} catch (error) {
			debugLog("hindsight.auto_recall_failed", {
				error: errorMessage(error),
			});
			return { text: undefined, pages: [], truncated: false };
		}
		const fragments = hits.map((hit) => `From "${hit.page}" (${hit.pageId}): ${hit.snippet}`);
		const text = renderMemoryContainer(fragments, this.resolved.config.maxMemoryChars);
		const result: PromptRecallResult = {
			text,
			pages: hits,
			// The container announces its own truncation; the injection report repeats it.
			truncated: text?.includes(TRUNCATION_NOTICE) ?? false,
		};

		if (this.#recallCache.size >= HindsightSession.#MAX_CACHE_ENTRIES) {
			const oldestKey = this.#recallCache.keys().next().value;
			if (oldestKey !== undefined) this.#recallCache.delete(oldestKey);
		}
		this.#recallCache.set(key, result);
		this.#lastRecallResult = result;
		return result;
	}

	/** Queues this run's turns for writeback. */
	agentEnd(event: AgentEndEvent, ctx: ExtensionContext): void {
		if (!this.resolved.config.retainSessions) return;
		const turns = buildHindsightTurns(event.messages);
		if (turns.length === 0) return;
		this.retainQueue.enqueue(sessionIdOf(ctx), turns, this.#lifecycleSignal);
	}

	/** Flushes pending writeback within a bounded grace period, then cancels what is left. */
	async dispose(): Promise<void> {
		const drained = await this.retainQueue.drain();
		if (!drained) {
			debugLog("hindsight.retain_drain_timeout", {
				...this.retainQueue.status(),
			});
		}
	}
}

function sessionIdOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return "unknown";
	}
}

/**
 * Resolves configuration and opens the gateway.
 *
 * Returns `disabled` — with no client constructed, no network client loaded, and no
 * fallback config file read — unless `pi-ext-memory.hindsight.enabled` is explicitly true.
 */
export async function startHindsightSession(
	cwd: string,
	signal: AbortSignal,
): Promise<HindsightStart> {
	const resolved = await loadHindsightConfig(cwd, process.env, signal);
	if (resolved === undefined) return { status: "disabled" };
	const gateway = await openHindsightGateway(resolved);
	if ("error" in gateway) return { status: "error", error: gateway.error };
	return { status: "ready", session: new HindsightSession(resolved, gateway, signal) };
}
