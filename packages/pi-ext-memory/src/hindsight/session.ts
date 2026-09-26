import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { debugLog } from "../debug-log.js";
import {
	type HindsightGateway,
	type HindsightPageSummary,
	openHindsightGateway,
} from "./client.js";
import { loadHindsightConfig, type ResolvedHindsight } from "./config.js";
import { renderHindsightPreamble, renderMemoryContainer } from "./prompt.js";
import { HindsightRetainQueue } from "./queue.js";
import type { HindsightToolContext } from "./tools.js";
import { buildHindsightTurns } from "./transcript.js";

/** Knowledge-page hits injected before a turn when auto-recall is on. */
export const AUTO_RECALL_PAGE_LIMIT = 3;

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
	#firstTurn = true;
	#lifecycleSignal: AbortSignal;

	constructor(resolved: ResolvedHindsight, gateway: HindsightGateway, signal: AbortSignal) {
		this.resolved = resolved;
		this.gateway = gateway;
		this.retainQueue = new HindsightRetainQueue(gateway);
		this.#lifecycleSignal = signal;
	}

	/** Context handed to the tool registrations. */
	toolContext(): HindsightToolContext {
		return { gateway: this.gateway, resolved: this.resolved, retainQueue: this.retainQueue };
	}

	/**
	 * Adds long-term memory to the prompt.
	 *
	 * The first turn of a session also receives the preamble that explains the memory and
	 * its tools; later turns only receive retrieved facts, so guidance the model has
	 * already read is not paid for again.
	 */
	async beforeAgentStart(
		event: BeforeAgentStartEvent,
	): Promise<{ systemPrompt: string } | undefined> {
		if (this.#lifecycleSignal.aborted) return undefined;
		const sections: string[] = [];
		const firstTurn = this.#firstTurn;
		this.#firstTurn = false;

		if (firstTurn) {
			sections.push(await this.#renderPreamble());
		}
		if (this.resolved.config.autoRecall && event.prompt.trim().length > 0) {
			const recalled = await this.#recallForPrompt(event.prompt);
			if (recalled !== undefined) sections.push(recalled);
		}
		if (sections.length === 0) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${sections.join("\n\n")}` };
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
				error: error instanceof Error ? error.message : String(error),
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

	async #recallForPrompt(prompt: string): Promise<string | undefined> {
		let fragments: string[];
		try {
			const hits = await this.gateway.searchPages(
				prompt,
				AUTO_RECALL_PAGE_LIMIT,
				this.#lifecycleSignal,
			);
			fragments = hits.map((hit) => `From "${hit.page}" (${hit.pageId}): ${hit.snippet}`);
		} catch (error) {
			debugLog("hindsight.auto_recall_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		return renderMemoryContainer(fragments, this.resolved.config.maxMemoryChars);
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
