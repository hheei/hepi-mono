import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	getHepiRuntimeSettingsRegistry,
	hepiAuthenticatedModelSelectionOptions,
	PARENT_CONTEXT_PROJECTION_SERVICE,
	provideService,
	registerExtensionLifecycle,
	registerHepiSettings,
	registerManagedTool,
	setManagedLoadoutToolsActive,
} from "@hheei/pi-ext-core";
import { Type } from "typebox";
import {
	createMctxFeature,
	type MctxFeature,
	type MctxFlushResult,
	type MctxHistorianCommandResult,
	type MctxHistoryOperation,
	type MctxHistoryResult,
	// Memory-system command/operation types, disabled and kept for revival:
	// type MctxEmbedBackfillResult,
	// type MctxMemoryOperation,
	// type MctxNoteOperation,
} from "./feature.js";
import { MAX_CTX_EXPAND_CHARS, renderMctxHistoryTagPage } from "./history-tags.js";
import { createMctxSettingsProvider } from "./settings.js";
import type { MctxToolDefinition } from "./status-metrics.js";
import { openMctxStatusSurface } from "./status-surface.js";
import { renderMctxToolOutput } from "./tool-output.js";

const DEFAULT_CTX_HISTORY_LIMIT = 50;
const MAX_CTX_HISTORY_LIMIT = 100;
const MCTX_SUBCOMMANDS = [
	{
		value: "status",
		description: "Show read-only Magic Context status",
	},
	{
		value: "flush",
		description: "Apply queued context tag drops",
	},
	{
		value: "recomp",
		description: "Rebuild compartments from the current session branch",
	},
	{
		value: "wrapup",
		description: "Compact older turns while retaining recent messages",
	},
] as const;
const WRAPUP_MESSAGE_SUGGESTIONS = [2, 4, 8, 16] as const;

interface PiContextHook {
	on(
		event: "context",
		handler: (
			event: { readonly messages: readonly AgentMessage[] },
			context: ExtensionContext,
		) => { readonly messages: readonly AgentMessage[] } | undefined,
	): void;
}

function notifyFlushResult(result: MctxFlushResult, context: ExtensionContext): void {
	switch (result.kind) {
		case "flushed":
			context.ui.notify(
				result.dropped.length === 0
					? "No queued context tag drops to flush."
					: `Flushed context tag drops: ${result.dropped.map((tag) => `#${tag}`).join(", ")}.`,
				"info",
			);
			break;
		case "inactive":
			context.ui.notify("pi-mctx is not active for this session.", "error");
			break;
		case "stale":
			context.ui.notify("Context changed; retry /mctx flush.", "warning");
			break;
	}
}

function notifyHistorianCommandResult(
	command: "recomp" | "wrapup",
	result: MctxHistorianCommandResult,
	context: ExtensionContext,
): void {
	switch (result.kind) {
		case "scheduled":
			context.ui.notify(`MCTX ${command} historian run scheduled.`, "info");
			break;
		case "restarting":
			context.ui.notify(`MCTX ${command} will run after the active historian stops.`, "info");
			break;
		case "inactive":
			context.ui.notify("pi-mctx is not active for this session.", "error");
			break;
		case "stale":
			context.ui.notify(`Context changed; retry /mctx ${command}.`, "warning");
			break;
		case "historian-disabled":
			context.ui.notify("MCTX Historian is disabled in settings.", "warning");
			break;
		case "historian-unavailable":
			context.ui.notify(`MCTX Historian is unavailable: ${result.reason}`, "warning");
			break;
	}
}

// Core owns Pi's static registration and Loadout inventory; MCTX owns every tool's runtime behavior.
const MCTX_MANAGED_TOOL = {
	owner: "@hheei/pi-mctx",
	group: "Magic Context",
	priority: 0,
	conflictSets: [],
	defaultActive: true,
	forcedActive: true,
} as const;
const MCTX_MANAGED_TOOLS = [
	{ id: "ctx_reduce", ...MCTX_MANAGED_TOOL },
	{ id: "ctx_expand", ...MCTX_MANAGED_TOOL },
	{ id: "ctx_history", ...MCTX_MANAGED_TOOL },
] as const;

function registerContextHook(pi: ExtensionAPI, feature: MctxFeature): void {
	// Pi exposes this runtime hook, but the installed public extension declaration omits it.
	// The projection remains MCTX-owned because it validates its own branch graph;
	// core only supplies lifecycle cancellation and does not interpret context history.
	const hooks = pi as unknown as PiContextHook;
	hooks.on("context", (event, context) => feature.onContext(event.messages, context));
}

function registerCompactionHook(pi: ExtensionAPI, feature: MctxFeature): void {
	pi.on("session_before_compact", (event, context) => {
		if (feature.active() === undefined) return undefined;
		try {
			const result = feature.compact(event.branchEntries, event.preparation.tokensBefore, context);
			if (result.kind === "compaction") return { compaction: result.compaction };
		} catch {
			// An active MCTX runtime owns compact failure semantics. Letting Pi create
			// a second summary after a failed MCTX projection would corrupt that ownership.
		}
		return { cancel: true };
	});
}

function registerMctxCommand(
	pi: ExtensionAPI,
	feature: MctxFeature,
	getLifecycleSignal: () => AbortSignal | undefined,
): void {
	pi.registerCommand("mctx", {
		description: "Show Magic Context status or run a context command",
		getArgumentCompletions: (argumentPrefix) => {
			const prefix = argumentPrefix.trimStart().toLowerCase();
			const wrapupMatch = /^wrapup\s+([^\s]*)$/u.exec(prefix);
			if (wrapupMatch !== null) {
				const valuePrefix = wrapupMatch[1] ?? "";
				const matches = WRAPUP_MESSAGE_SUGGESTIONS.filter((value) =>
					String(value).startsWith(valuePrefix),
				).map((value) => ({
					value: `wrapup ${value}`,
					label: `wrapup ${value}`,
					description: `Retain at least ${value} recent messages`,
				}));
				return matches.length === 0 ? null : matches;
			}
			if (/\s/u.test(prefix)) return null;
			const matches = MCTX_SUBCOMMANDS.filter(({ value }) => value.startsWith(prefix)).map(
				({ value, description }) => ({ value, label: value, description }),
			);
			return matches.length === 0 ? null : matches;
		},
		handler: async (args, context) => {
			const value = args.trim();
			const parsed = /^(\S+)(?:\s+(.*))?$/su.exec(value);
			const subcommand = (parsed?.[1] ?? "").toLowerCase();
			const subcommandArgs = parsed?.[2]?.trim() ?? "";

			if (subcommand.length === 0 || /^status$/u.test(subcommand)) {
				if (subcommandArgs.length > 0) {
					context.ui.notify("Usage: /mctx status", "error");
					return;
				}
				if (context.mode !== "tui") {
					context.ui.notify("/mctx status is available only in the TUI", "warning");
					return;
				}
				const lifecycleSignal = getLifecycleSignal();
				if (lifecycleSignal === undefined || lifecycleSignal.aborted) {
					context.ui.notify("pi-mctx lifecycle is not active", "warning");
					return;
				}
				await openMctxStatusSurface(pi, context, feature, context, lifecycleSignal);
				return;
			}
			if (/^flush$/u.test(subcommand)) {
				if (subcommandArgs.length > 0) {
					context.ui.notify("Usage: /mctx flush", "error");
					return;
				}
				notifyFlushResult(feature.flush(context), context);
				return;
			}
			if (/^recomp$/u.test(subcommand)) {
				if (subcommandArgs.length > 0) {
					context.ui.notify("Usage: /mctx recomp", "error");
					return;
				}
				notifyHistorianCommandResult("recomp", feature.recomp(context), context);
				return;
			}
			if (/^wrapup$/u.test(subcommand)) {
				if (subcommandArgs.length === 0) {
					notifyHistorianCommandResult("wrapup", feature.wrapup(undefined, context), context);
					return;
				}
				if (!/^\d+$/u.test(subcommandArgs)) {
					context.ui.notify("Usage: /mctx wrapup [positive messages_to_keep]", "error");
					return;
				}
				const messagesToKeep = Number(subcommandArgs);
				if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep < 1) {
					context.ui.notify("Usage: /mctx wrapup [positive messages_to_keep]", "error");
					return;
				}
				notifyHistorianCommandResult("wrapup", feature.wrapup(messagesToKeep, context), context);
				return;
			}
			context.ui.notify(
				`Unknown MCTX subcommand: ${subcommand}. Usage: /mctx [status | flush | recomp | wrapup [messages_to_keep]]`,
				"error",
			);
		},
	});
}

/* Memory-system subcommand handlers stay disabled for revival (see docs/mctx/README.md).
 * Revival adds each handler to MCTX_SUBCOMMANDS and registerMctxCommand; it must not register aliases.
async function runDreamCommand(
	feature: MctxFeature,
	args: string,
	ctx: ExtensionContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/mctx dream requires interactive mode", "error");
		return;
	}
	const query = args.trim();
	if (query.length > 500) {
		ctx.ui.notify("Usage: /mctx dream [query up to 500 characters]", "error");
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
}
*/

/* Memory-system subcommand handler stays disabled for revival (see docs/mctx/README.md).
async function runEmbedCommand(feature: MctxFeature, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/mctx embed requires interactive mode", "error");
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
			return renderMctxToolOutput({
				body: JSON.stringify({ tags: result.tags, nextOffset: result.nextOffset }),
			});
		case "purged":
			return renderMctxToolOutput({ body: JSON.stringify({ deleted: result.deleted }) });
		case "inactive":
			return renderMctxToolOutput({
				body: "pi-mctx is not active for this session.",
				isError: true,
			});
		case "active-session":
			return renderMctxToolOutput({
				body: "ctx_history cannot purge the active session history ledger.",
				isError: true,
			});
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

function registerHistoryTools(pi: ExtensionAPI, feature: MctxFeature): void {
	registerManagedTool(
		pi,
		{ id: "ctx_reduce", ...MCTX_MANAGED_TOOL },
		defineTool({
			name: "ctx_reduce",
			label: "Reduce context",
			description: "Queue session-history tags to replace with recoverable dropped markers.",
			parameters: Type.Object({ drop: Type.String() }),
			async execute(_toolCallId, args, _signal, _onUpdate, context) {
				const tags = parseTagSelectors(args.drop);
				if (tags === undefined)
					return renderMctxToolOutput({
						body: "Invalid drop selector; use N, N-M, comma-separated.",
						isError: true,
					});
				const result = feature.reduce(tags, context);
				if (result.kind === "inactive")
					return renderMctxToolOutput({
						body: "pi-mctx is not active for this session.",
						isError: true,
					});
				if (result.kind === "stale")
					return renderMctxToolOutput({
						body: "Context changed; retry ctx_reduce.",
						isError: true,
					});
				return renderMctxToolOutput({
					body: `pending: ${result.queued?.map((tag) => `#${tag}`).join(", ") || "none"}\nrejected: ${result.rejected?.map((tag) => `#${tag}`).join(", ") || "none"}`,
				});
			},
		}),
	);
	registerManagedTool(
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
				if (tags === undefined)
					return renderMctxToolOutput({
						body: "Invalid tag selector; use N, N-M, comma-separated.",
						isError: true,
					});
				const result = feature.expand(tags, context);
				if (result.kind !== "expanded") {
					return renderMctxToolOutput({
						body:
							result.kind === "inactive"
								? "pi-mctx is not active for this session."
								: "Context changed; retry ctx_expand.",
						isError: true,
					});
				}
				const page = renderMctxHistoryTagPage(result.tags, args.offset, args.limit);
				if (page === undefined) {
					return renderMctxToolOutput({ body: "offset or limit is invalid.", isError: true });
				}
				return renderMctxToolOutput({
					body: `${page.text || "No current-session tags matched."}${page.nextOffset === undefined ? "" : `\n\nNext offset: ${page.nextOffset}`}${result.rejected.length === 0 ? "" : `\n\nRejected tags: ${result.rejected.map((tag) => `#${tag}`).join(", ")}`}`,
				});
			},
		}),
	);
	registerManagedTool(
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
					return renderMctxToolOutput({
						body: "Invalid ctx_history parameters; purge requires non-active session_id.",
						isError: true,
					});
				return renderHistoryToolResult(feature.history(operation, context));
			},
		}),
	);
	/*
	 * Memory-system registration disabled (see docs/mctx/README.md): the
	 * durable memory/search/notes features are parked behind this hook and
	 * kept for revival. historian and history tags stay active.
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
	const feature = createMctxFeature({
		listTools: (): readonly MctxToolDefinition[] =>
			pi.getAllTools().map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
	});
	const settingsRegistry = getHepiRuntimeSettingsRegistry(pi);
	let lifecycleSignal: AbortSignal | undefined;
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-mctx",
		start: async (context) => {
			const modelRegistry = context.extension.modelRegistry;
			const settingsProvider = createMctxSettingsProvider({
				modelOptions:
					modelRegistry === undefined
						? [{ value: "", label: "Not set" }]
						: hepiAuthenticatedModelSelectionOptions(modelRegistry),
			});
			const unregisterSettings = registerHepiSettings(settingsProvider, settingsRegistry);
			context.resources.add("mctx-historian-settings", unregisterSettings);
			lifecycleSignal = context.signal;
			context.resources.add("ctx-status-signal", () => {
				if (lifecycleSignal === context.signal) lifecycleSignal = undefined;
			});
			setManagedLoadoutToolsActive(context, MCTX_MANAGED_TOOLS, false);
			await feature.start(context);
			if (feature.active() !== undefined) {
				setManagedLoadoutToolsActive(context, MCTX_MANAGED_TOOLS, true);
				provideService(context, PARENT_CONTEXT_PROJECTION_SERVICE, feature);
			}
		},
	});
	registerMctxCommand(pi, feature, () => lifecycleSignal);
	registerHistoryTools(pi, feature);
	// Memory-system subcommands remain absent from the router and completions;
	// their handlers stay above for revival (see docs/mctx/README.md).
	registerContextHook(pi, feature);
	registerCompactionHook(pi, feature);
	pi.on("turn_end", (_event, context) => feature.onTurnEnd(context));
}
