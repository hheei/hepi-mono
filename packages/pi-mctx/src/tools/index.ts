/**
 * Pi-side tool registration.
 *
 * Registers the stable `mctx_search` / optional `mctx_memory` surface plus
 * `mctx_note`, `mctx_expand`, and `mctx_reduce`. Storage configuration changes
 * tool implementations, never their agent-facing names.
 *
 * `mctx_reduce` is part of the primary session-scoped surface. It is omitted
 * only for `--no-session` child processes where session-scoped tools would
 * resolve to the hidden ephemeral child session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getToolTui, registerToolTuiTrace, type ToolTui } from "@hheei/pi-ext-core";
import type { ContextDatabase } from "#core/features/storage";
import type { AgentMemoryClientPort } from "../agentmemory/client";
import type { AgentMemoryIdentity } from "../agentmemory/runtime";
import { createCtxExpandTool } from "./ctx-expand";
import { createCtxMemoryTool } from "./ctx-memory";
import { createCtxNoteTool } from "./ctx-note";
import { createCtxReduceTool } from "./ctx-reduce";
import { createCtxSearchTool } from "./ctx-search";
import { createMemorySaveTool } from "./memory-save";

export interface RegisterToolsOptions {
	db: ContextDatabase;
	ensureProjectRegistered?: ((directory: string, db: ContextDatabase) => Promise<void>) | undefined;
	memoryEnabled?: boolean | undefined;
	embeddingEnabled?: boolean | undefined;
	gitCommitsEnabled?: boolean | undefined;
	/** Resolve the current directory's project identity using the user-level home-project setting. */
	resolveProjectIdentity?: ((ctx: { cwd: string }) => string | undefined) | undefined;
	/** When true, mctx_memory exposes dreamer-only actions (update, merge, archive).
	 *  Set by the subagent extension entry when the parent passes
	 *  `--magic-context-dreamer-actions`. The main extension entry
	 *  (./index.ts) leaves this false for the primary-agent surface. */
	allowDreamerActions?: boolean | undefined;
	/** Number of recent tags that mctx_reduce should treat as protected
	 *  (deferred drops instead of immediate). Should match `magic_context.protected_tags`. */
	protectedTags?: number | undefined;
	/** Resolve protected-tag config from the current cwd at tool-call time. */
	resolveProtectedTags?: ((ctx: { cwd: string }) => number | undefined) | undefined;
	/** When true, mctx_note accepts smart notes (surface_condition) because
	 *  the dreamer is configured to evaluate them. When false, smart-note
	 *  writes are rejected to avoid stuck-pending state. */
	dreamerEnabled?: boolean | undefined;
	/** Resolve smart-note enablement from the current cwd at tool-call time. */
	resolveDreamerEnabled?: ((ctx: { cwd: string }) => boolean | undefined) | undefined;
	/** When false, omit mctx_memory from the registered surface. Sidekick only
	 *  needs read-only mctx_search; dreamer and the main agent keep mctx_memory. */
	memoryToolEnabled?: boolean | undefined;
	/** When true, omit session-scoped tools (mctx_note, mctx_expand) from the
	 *  registered surface. Set by `--no-session` children (sidekick, dreamer):
	 *  those tools resolve `ctx.sessionManager.getSessionId()` to the EPHEMERAL
	 *  child session, so mctx_note would write notes orphaned under the hidden
	 *  child id and mctx_expand would expand the child's empty transcript. */
	sessionScopedToolsDisabled?: boolean | undefined;
	/** In compaction-off mode, omit mctx_reduce and keep the other Pi tools available. */
	compactionOff?: boolean | undefined;
	/** When set, register transactional AgentMemory through `mctx_memory`. */
	memorySaveTool?:
		| {
				queueMemory(input: {
					readonly cwd: string;
					readonly content: string;
					readonly type?: string | undefined;
				}): Promise<{ status: "queued" | "delivered" | "failed"; id: string }>;
		  }
		| undefined;
	remoteSearch?:
		| {
				client: AgentMemoryClientPort;
				identity: (cwd: string) => AgentMemoryIdentity;
				remoteSessionId?: ((piSessionId: string) => string | undefined) | undefined;
		  }
		| undefined;
}

function toolSummary(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return undefined;
	}
	const value = args as Record<string, unknown>;
	if (typeof value.query === "string" && value.query.trim() !== "") {
		return value.query.trim();
	}
	if (typeof value.drop === "string" && value.drop.trim() !== "") {
		return value.drop.trim();
	}
	if (typeof value.message === "number") return `#${value.message}`;
	if (typeof value.start === "number" && typeof value.end === "number") {
		return `${value.start}-${value.end}`;
	}
	const action = typeof value.action === "string" ? value.action.trim() : "";
	if (action === "") return undefined;
	const ids = Array.isArray(value.ids)
		? value.ids.filter((id): id is number => typeof id === "number").join(",")
		: typeof value.note_id === "number"
			? String(value.note_id)
			: "";
	return ids === "" ? action : `${action} ${ids}`;
}

function frameTool<T>(tui: ToolTui, tool: T): T {
	return tui.frame(tool as never, {
		summary: (args) => toolSummary(args),
	}) as T;
}

export function registerMagicContextTools(pi: ExtensionAPI, opts: RegisterToolsOptions): void {
	const tui = getToolTui(pi);
	if (typeof pi.on === "function") registerToolTuiTrace(pi);
	const resolveProjectIdentity = opts.resolveProjectIdentity
		? (directory: string) => opts.resolveProjectIdentity?.({ cwd: directory })
		: undefined;

	pi.registerTool(
		frameTool(
			tui,
			createCtxSearchTool({
				db: opts.db,
				ensureProjectRegistered: opts.ensureProjectRegistered,
				memoryEnabled: opts.memoryEnabled,
				embeddingEnabled: opts.embeddingEnabled,
				gitCommitsEnabled: opts.gitCommitsEnabled,
				resolveProjectIdentity,
				remoteSearch: opts.remoteSearch,
			}),
		),
	);

	if (opts.memoryToolEnabled !== false) {
		pi.registerTool(
			frameTool(
				tui,
				createCtxMemoryTool({
					db: opts.db,
					ensureProjectRegistered: opts.ensureProjectRegistered,
					memoryEnabled: opts.memoryEnabled,
					embeddingEnabled: opts.embeddingEnabled,
					allowDreamerActions: opts.allowDreamerActions ?? false,
					resolveProjectIdentity,
				}),
			),
		);
	}
	if (opts.memorySaveTool) {
		pi.registerTool(frameTool(tui, createMemorySaveTool(opts.memorySaveTool)));
	}

	// mctx_note and mctx_expand are session-scoped: they resolve the CURRENT
	// session id at call time. For `--no-session` children that id is the hidden
	// ephemeral child session, so a note would be orphaned and an expand would
	// target the child's empty transcript. Omit them for those children; mctx_search
	// stays available and mctx_memory is controlled above.
	if (!opts.sessionScopedToolsDisabled) {
		pi.registerTool(
			frameTool(
				tui,
				createCtxNoteTool({
					db: opts.db,
					dreamerEnabled: opts.dreamerEnabled ?? false,
					resolveDreamerEnabled: opts.resolveDreamerEnabled,
					resolveProjectIdentity,
				}),
			),
		);

		pi.registerTool(frameTool(tui, createCtxExpandTool({ db: opts.db })));
	}

	// mctx_reduce is session-scoped just like mctx_note/mctx_expand: it resolves the
	// CURRENT session id at call time. Omit it for `--no-session` children where
	// that id points at a hidden ephemeral child session.
	if (!opts.sessionScopedToolsDisabled && !opts.compactionOff) {
		pi.registerTool(
			frameTool(
				tui,
				createCtxReduceTool({
					db: opts.db,
					protectedTags: opts.protectedTags ?? 20,
					resolveProtectedTags: opts.resolveProtectedTags,
				}),
			),
		);
	}
}
