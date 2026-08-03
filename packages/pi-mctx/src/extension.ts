import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	PARENT_CONTEXT_PROJECTION_SERVICE,
	provideService,
	registerExtensionLifecycle,
	registerManagedLoadoutTool,
} from "@hheei/pi-ext-core";
import { Type } from "typebox";
import {
	createMctxFeature,
	type MctxAugmentResult,
	type MctxFeature,
	type MctxHistoryOperation,
	type MctxHistoryResult,
	// Memory-system command/operation types, disabled and kept for revival:
	// type MctxDreamResult,
	// type MctxEmbedBackfillResult,
	// type MctxMemoryOperation,
	// type MctxNoteOperation,
} from "./feature.js";
import { MAX_CTX_EXPAND_CHARS, renderMctxHistoryTagPage } from "./history-tags.js";

const DEFAULT_CTX_HISTORY_LIMIT = 50;
const MAX_CTX_HISTORY_LIMIT = 100;

interface PiContextHook {
	on(
		event: "context",
		handler: (
			event: { readonly messages: readonly AgentMessage[] },
			context: ExtensionContext,
		) => { readonly messages: readonly AgentMessage[] } | undefined,
	): void;
}

// Core owns Pi's static registration and Loadout inventory; MCTX owns every tool's runtime behavior.
const MCTX_MANAGED_TOOL = {
	owner: "@hheei/pi-mctx",
	group: "Magic Context",
	priority: 0,
	conflictSets: [],
	defaultActive: true,
} as const;

function registerContextHook(pi: ExtensionAPI, feature: MctxFeature): void {
	// Pi exposes this runtime hook, but the installed public extension declaration omits it.
	// The projection remains MCTX-owned because it validates its own branch graph;
	// core only supplies lifecycle cancellation and does not interpret context history.
	const hooks = pi as unknown as PiContextHook;
	hooks.on("context", (event, context) => feature.onContext(event.messages, context));
}

function registerSidekickCommand(pi: ExtensionAPI, feature: MctxFeature): void {
	pi.registerCommand("ctx-aug", {
		description: "Run a read-only sidekick child and inject the retrieved augmentation once",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/ctx-aug requires interactive mode", "error");
				return;
			}
			const query = args.trim();
			if (query.length === 0 || query.length > 500) {
				ctx.ui.notify("Usage: /ctx-aug <query up to 500 characters>", "error");
				return;
			}
			const result: MctxAugmentResult = await feature.augment(query, ctx);
			switch (result.kind) {
				case "injected":
					ctx.ui.notify("Sidekick augmentation injected into the next context turn.", "info");
					break;
				case "inactive":
					ctx.ui.notify("pi-mctx is not active for this session.", "error");
					break;
				case "cancelled":
					ctx.ui.notify("Sidekick augmentation cancelled.", "warning");
					break;
				case "empty":
					ctx.ui.notify("Sidekick found nothing to augment; context unchanged.", "warning");
					break;
				case "failed":
					ctx.ui.notify(`Sidekick augmentation failed: ${result.reason}`, "error");
					break;
			}
		},
	});
}

/* Memory-system command handlers, disabled with their registration and kept
 * for revival (see docs/mctx/README.md).
function registerDreamCommand(pi: ExtensionAPI, feature: MctxFeature): void {
	pi.registerCommand("ctx-dream", {
		description: "Run a read-only Dreamer child to evaluate pending smart-condition notes",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/ctx-dream requires interactive mode", "error");
				return;
			}
			const query = args.trim();
			if (query.length > 500) {
				ctx.ui.notify("Usage: /ctx-dream [query up to 500 characters]", "error");
				return;
			}
			const result: MctxDreamResult = await feature.dream(query, ctx);
			switch (result.kind) {
				case "reported":
					ctx.ui.notify(result.summary, "info");
					break;
				case "inactive":
					ctx.ui.notify("pi-mctx is not active for this session.", "error");
					break;
				case "cancelled":
					ctx.ui.notify("Dreamer evaluation cancelled.", "warning");
					break;
				case "empty":
					ctx.ui.notify("No smart-condition notes to evaluate.", "warning");
					break;
				case "failed":
					ctx.ui.notify(`Dreamer evaluation failed: ${result.reason}`, "error");
					break;
			}
		},
	});
}
*/

/* Memory-system command handler, disabled with its registration and kept for
 * revival (see docs/mctx/README.md).
function registerEmbedCommand(pi: ExtensionAPI, feature: MctxFeature): void {
	pi.registerCommand("ctx-embed", {
		description: "Embed all active project memories that are missing vectors",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/ctx-embed requires interactive mode", "error");
				return;
			}
			const result: MctxEmbedBackfillResult = await feature.embedBackfill(ctx);
			switch (result.kind) {
				case "done":
					ctx.ui.notify(
						`Embedding backfill: ${result.embedded} embedded, ${result.skipped} skipped, ${result.failed} failed.`,
						"info",
					);
					break;
				case "inactive":
					ctx.ui.notify("pi-mctx is not active for this session.", "error");
					break;
				case "busy":
					ctx.ui.notify("An embedding backfill is already running.", "warning");
					break;
				case "cancelled":
					ctx.ui.notify("Embedding backfill cancelled.", "warning");
					break;
				case "failed":
					ctx.ui.notify(`Embedding backfill failed: ${result.reason}`, "error");
					break;
			}
		},
	});
}
*/

function parseTagSelectors(value: string): readonly number[] | undefined {
	const numbers = new Set<number>();
	for (const part of value.split(",")) {
		const range = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
		if (range === null) return undefined;
		const start = Number(range[1]);
		const end = range[2] === undefined ? start : Number(range[2]);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
			return undefined;
		}
		for (let number = start; number <= end; number++) {
			if (numbers.size >= 100) return undefined;
			numbers.add(number);
		}
	}
	return numbers.size === 0 ? undefined : [...numbers].sort((left, right) => left - right);
}

/* Memory-system operation parsers, disabled with their tool registration and
 * kept for revival (see docs/mctx/README.md).
function memoryOperation(args: Record<string, unknown>): MctxMemoryOperation | undefined {
	const action = args.action;
	const ids = args.ids;
	const id = args.id;
	const expectedRevision = args.expectedRevision;
	const category = args.category;
	const content = args.content;
	if (
		action === "get" &&
		Array.isArray(ids) &&
		ids.every((value): value is number => Number.isSafeInteger(value) && value > 0)
	)
		return { action, memoryIds: ids };
	if (action === "write" && typeof category === "string" && typeof content === "string") {
		const matchedCategory = MCTX_MEMORY_CATEGORIES.find((value) => value === category);
		if (matchedCategory !== undefined) return { action, category: matchedCategory, content };
	}
	if (
		action === "update" &&
		typeof id === "number" &&
		Number.isSafeInteger(id) &&
		id > 0 &&
		typeof expectedRevision === "number" &&
		Number.isSafeInteger(expectedRevision) &&
		expectedRevision > 0 &&
		typeof content === "string"
	)
		return { action, memoryId: id, expectedRevision, content };
	if (
		action === "archive" &&
		typeof id === "number" &&
		Number.isSafeInteger(id) &&
		id > 0 &&
		typeof expectedRevision === "number" &&
		Number.isSafeInteger(expectedRevision) &&
		expectedRevision > 0
	)
		return { action, memoryId: id, expectedRevision };
	return undefined;
}

function noteOperation(args: Record<string, unknown>): MctxNoteOperation | undefined {
	const action = args.action;
	const id = args.id;
	const expectedRevision = args.expectedRevision;
	const content = args.content;
	const anchorTag = args.anchorTag;
	const smartCondition = args.smartCondition;
	const status = args.status;
	const validAnchorTag =
		anchorTag === undefined ||
		(anchorTag !== null &&
			typeof anchorTag === "number" &&
			Number.isSafeInteger(anchorTag) &&
			anchorTag > 0);
	const validSmartCondition =
		smartCondition === undefined ||
		smartCondition === null ||
		(typeof smartCondition === "string" && Boolean(smartCondition.trim()));
	if (action === "read" && (status === undefined || status === "active" || status === "dismissed"))
		return status === undefined ? { action } : { action, status };
	if (
		action === "write" &&
		typeof content === "string" &&
		content.trim() &&
		validAnchorTag &&
		anchorTag !== null &&
		validSmartCondition &&
		smartCondition !== null
	)
		return {
			action,
			content,
			...(anchorTag === undefined ? {} : { anchorTag }),
			...(smartCondition === undefined ? {} : { smartCondition }),
		};
	if (
		action === "update" &&
		typeof id === "number" &&
		Number.isSafeInteger(id) &&
		id > 0 &&
		typeof expectedRevision === "number" &&
		Number.isSafeInteger(expectedRevision) &&
		expectedRevision > 0 &&
		typeof content === "string" &&
		content.trim() &&
		validAnchorTag &&
		validSmartCondition
	)
		return {
			action,
			noteId: id,
			expectedRevision,
			content,
			...(anchorTag === undefined ? {} : { anchorTag }),
			...(smartCondition === undefined ? {} : { smartCondition }),
		};
	if (
		action === "dismiss" &&
		typeof id === "number" &&
		Number.isSafeInteger(id) &&
		id > 0 &&
		typeof expectedRevision === "number" &&
		Number.isSafeInteger(expectedRevision) &&
		expectedRevision > 0
	)
		return { action, noteId: id, expectedRevision };
	return undefined;
}
*/

function historyOperation(args: Record<string, unknown>): MctxHistoryOperation | undefined {
	const action = args.action;
	const sessionId = args.session_id;
	const offset = args.offset;
	const limit = args.limit ?? DEFAULT_CTX_HISTORY_LIMIT;
	const validSessionId =
		sessionId === undefined || (typeof sessionId === "string" && Boolean(sessionId.trim()));
	const validOffset =
		offset === undefined ||
		(Number.isSafeInteger(offset) && typeof offset === "number" && offset >= 0);
	if (
		!Number.isSafeInteger(limit) ||
		typeof limit !== "number" ||
		limit < 1 ||
		limit > MAX_CTX_HISTORY_LIMIT ||
		!validSessionId ||
		!validOffset
	)
		return undefined;
	if (action === "list")
		return {
			action,
			limit,
			...(offset === undefined ? {} : { offset }),
			...(typeof sessionId === "string" ? { sessionId } : {}),
		};
	if (action === "purge" && typeof sessionId === "string") return { action, sessionId };
	return undefined;
}

function renderHistoryToolResult(result: MctxHistoryResult) {
	switch (result.kind) {
		case "history":
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ tags: result.tags, nextOffset: result.nextOffset }),
					},
				],
				details: undefined,
			};
		case "purged":
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ deleted: result.deleted }) }],
				details: undefined,
			};
		case "inactive":
			return {
				content: [{ type: "text" as const, text: "pi-mctx is not active for this session." }],
				details: undefined,
				isError: true,
			};
		case "active-session":
			return {
				content: [
					{
						type: "text" as const,
						text: "ctx_history cannot purge the active session history ledger.",
					},
				],
				details: undefined,
				isError: true,
			};
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

function registerHistoryTools(pi: ExtensionAPI, feature: MctxFeature): void {
	registerManagedLoadoutTool(
		pi,
		{ id: "ctx_reduce", ...MCTX_MANAGED_TOOL },
		defineTool({
			name: "ctx_reduce",
			label: "Reduce context",
			description: "Queue session-history tags to replace with recoverable dropped markers.",
			parameters: Type.Object({ drop: Type.String() }),
			async execute(_toolCallId, args, _signal, _onUpdate, context) {
				const tags = parseTagSelectors(args.drop);
				if (tags === undefined) {
					return {
						content: [
							{ type: "text", text: "Invalid drop selector; use N, N-M, comma-separated." },
						],
						details: undefined,
						isError: true,
					};
				}
				const result = feature.reduce(tags, context);
				if (result.kind === "inactive") {
					return {
						content: [{ type: "text", text: "pi-mctx is not active for this session." }],
						details: undefined,
						isError: true,
					};
				}
				if (result.kind === "stale") {
					return {
						content: [{ type: "text", text: "Context changed; retry ctx_reduce." }],
						details: undefined,
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Queued drops: ${result.queued?.join(", ") || "none"}. Rejected: ${result.rejected?.join(", ") || "none"}.`,
						},
					],
					details: undefined,
				};
			},
		}),
	);
	registerManagedLoadoutTool(
		pi,
		{ id: "ctx_expand", ...MCTX_MANAGED_TOOL },
		defineTool({
			name: "ctx_expand",
			label: "Expand context",
			description: "Read retained source for current-session context tags without reinjecting it.",
			parameters: Type.Object({
				tags: Type.String(),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CTX_EXPAND_CHARS })),
			}),
			async execute(_toolCallId, args, _signal, _onUpdate, context) {
				const tags = parseTagSelectors(args.tags);
				if (tags === undefined) {
					return {
						content: [{ type: "text", text: "Invalid tag selector; use N, N-M, comma-separated." }],
						details: undefined,
						isError: true,
					};
				}
				const result = feature.expand(tags, context);
				if (result.kind !== "expanded") {
					return {
						content: [
							{
								type: "text",
								text:
									result.kind === "inactive"
										? "pi-mctx is not active for this session."
										: "Context changed; retry ctx_expand.",
							},
						],
						details: undefined,
						isError: true,
					};
				}
				const page = renderMctxHistoryTagPage(result.tags, args.offset, args.limit);
				if (page === undefined) {
					return {
						content: [{ type: "text", text: "offset or limit is invalid." }],
						details: undefined,
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `${page.text || "No current-session tags matched."}${page.nextOffset === undefined ? "" : `\n\nNext offset: ${page.nextOffset}`}${result.rejected.length === 0 ? "" : `\n\nRejected tags: ${result.rejected.join(", ")}`}`,
						},
					],
					details: undefined,
				};
			},
		}),
	);
	registerManagedLoadoutTool(
		pi,
		{ id: "ctx_history", ...MCTX_MANAGED_TOOL },
		defineTool({
			name: "ctx_history",
			label: "Manage history",
			description:
				"List or purge retained context history for non-active sessions in the current project.",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("list"), Type.Literal("purge")]),
				session_id: Type.Optional(Type.String()),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CTX_HISTORY_LIMIT })),
			}),
			async execute(_toolCallId, args, _signal, _onUpdate, context) {
				const operation = historyOperation(args);
				if (operation === undefined)
					return {
						content: [
							{
								type: "text",
								text: "Invalid ctx_history parameters; purge requires non-active session_id.",
							},
						],
						details: undefined,
						isError: true,
					};
				return renderHistoryToolResult(feature.history(operation, context));
			},
		}),
	);
	/*
	 * Memory-system registration disabled (see docs/mctx/README.md): the
	 * durable memory/search/notes features are parked behind this hook and
	 * kept for revival. historian, history tags and sidekick stay active.
	registerManagedLoadoutTool(
		pi,
		{ id: "ctx_search", ...MCTX_MANAGED_TOOL },
		defineTool({
			name: "ctx_search",
			label: "Search context",
			description:
				"Search bounded project memories, session notes, retained history, Git commits, and optional primer text.",
			parameters: Type.Object({
				query: Type.String({ minLength: 1, maxLength: 500 }),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CTX_SEARCH_LIMIT })),
				sources: Type.Optional(
					Type.Array(Type.Union(MCTX_SEARCH_SOURCES.map((source) => Type.Literal(source))), {
						minItems: 1,
						maxItems: MCTX_SEARCH_SOURCES.length,
					}),
				),
			}),
			async execute(_toolCallId, args, signal, _onUpdate, context) {
				const operation = searchOperation(args);
				if (operation === undefined)
					return {
						content: [{ type: "text", text: "Invalid ctx_search parameters." }],
						details: undefined,
						isError: true,
					};
				return renderSearchToolResult(
					await feature.search(operation, context, signal ?? new AbortController().signal),
				);
			},
		}),
	);
	*/
	/*
	registerManagedLoadoutTool(
		pi,
		{ id: "ctx_memory", ...MCTX_MANAGED_TOOL },
		defineTool({
			name: "ctx_memory",
			label: "Manage memory",
			description: "Read and manage durable project memories.",
			parameters: Type.Object({
				action: Type.Union([
					Type.Literal("write"),
					Type.Literal("get"),
					Type.Literal("update"),
					Type.Literal("archive"),
				]),
				ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
				id: Type.Optional(Type.Integer({ minimum: 1 })),
				expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
				category: Type.Optional(Type.String()),
				content: Type.Optional(Type.String()),
			}),
			async execute(_toolCallId, args, _signal, _onUpdate, context) {
				const operation = memoryOperation(args);
				if (operation === undefined)
					return {
						content: [{ type: "text", text: "Invalid ctx_memory parameters." }],
						details: undefined,
						isError: true,
					};
				const result = feature.memory(operation, context);
				if (result.kind !== "memory")
					return {
						content: [
							{
								type: "text",
								text:
									result.kind === "inactive"
										? "pi-mctx is not active for this session."
										: "Memory changed; retry with a current revision.",
							},
						],
						details: undefined,
						isError: true,
					};
				return {
					content: [{ type: "text", text: JSON.stringify(result.memories) }],
					details: undefined,
				};
			},
		}),
	);
	*/
	/*
	registerManagedLoadoutTool(
		pi,
		{ id: "ctx_note", ...MCTX_MANAGED_TOOL },
		defineTool({
			name: "ctx_note",
			label: "Manage notes",
			description: "Read and manage durable notes for this MCTX session.",
			parameters: Type.Object({
				action: Type.Union([
					Type.Literal("write"),
					Type.Literal("read"),
					Type.Literal("update"),
					Type.Literal("dismiss"),
				]),
				id: Type.Optional(Type.Integer({ minimum: 1 })),
				expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
				content: Type.Optional(Type.String()),
				anchorTag: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
				smartCondition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("dismissed")])),
			}),
			async execute(_toolCallId, args, _signal, _onUpdate, context) {
				const operation = noteOperation(args);
				if (operation === undefined)
					return {
						content: [{ type: "text", text: "Invalid ctx_note parameters." }],
						details: undefined,
						isError: true,
					};
				const result = feature.note(operation, context);
				if (result.kind !== "notes")
					return {
						content: [
							{
								type: "text",
								text:
									result.kind === "inactive"
										? "pi-mctx is not active for this session."
										: result.kind === "invalid-anchor"
											? "anchorTag is not a current-session history tag."
											: "Note changed; retry with a current revision.",
							},
						],
						details: undefined,
						isError: true,
					};
				return {
					content: [{ type: "text", text: JSON.stringify(result.notes) }],
					details: undefined,
				};
			},
		}),
	);
	*/
}

/**
 * Pi package entry. `turn_end` schedules historian work in the background; the
 * private context hook applies only an already-validated MCTX projection and never waits for it.
 */
export default function piMctxExtension(pi: ExtensionAPI): void {
	const feature = createMctxFeature();
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-mctx",
		start: async (context) => {
			await feature.start(context);
			if (feature.active() !== undefined)
				provideService(context, PARENT_CONTEXT_PROJECTION_SERVICE, feature);
		},
	});
	registerHistoryTools(pi, feature);
	registerSidekickCommand(pi, feature);
	// Memory-system commands disabled (see docs/mctx/README.md); registration
	// stays behind this hook and the handlers are kept for revival.
	// registerDreamCommand(pi, feature);
	// registerEmbedCommand(pi, feature);
	registerContextHook(pi, feature);
	pi.on("turn_end", (_event, context) => feature.onTurnEnd(context));
}
