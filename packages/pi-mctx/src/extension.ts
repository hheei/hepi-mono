import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle, registerManagedLoadoutTool } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { createMctxFeature, type MctxMemoryOperation, type MctxNoteOperation } from "./feature.js";
import { MAX_CTX_EXPAND_CHARS, renderMctxHistoryTagPage } from "./history-tags.js";
import { MCTX_MEMORY_CATEGORIES } from "./store.js";

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

function registerContextHook(
	pi: ExtensionAPI,
	feature: ReturnType<typeof createMctxFeature>,
): void {
	// Pi exposes this runtime hook, but the installed public extension declaration omits it.
	// The projection remains MCTX-owned because it validates its own branch graph;
	// core only supplies lifecycle cancellation and does not interpret context history.
	const hooks = pi as unknown as PiContextHook;
	hooks.on("context", (event, context) => feature.onContext(event.messages, context));
}

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

function registerHistoryTools(
	pi: ExtensionAPI,
	feature: ReturnType<typeof createMctxFeature>,
): void {
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
}

/**
 * Pi package entry. `turn_end` schedules historian work in the background; the
 * private context hook applies only an already-validated MCTX projection and never waits for it.
 */
export default function piMctxExtension(pi: ExtensionAPI): void {
	const feature = createMctxFeature();
	registerExtensionLifecycle(pi, {
		key: "@hheei/pi-mctx",
		start: feature.start,
	});
	registerHistoryTools(pi, feature);
	registerContextHook(pi, feature);
	pi.on("turn_end", (_event, context) => feature.onTurnEnd(context));
}
