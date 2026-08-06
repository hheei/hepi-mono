import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolResultEvent,
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
} from "./feature.js";
import { MAX_CTX_EXPAND_CHARS, renderMctxHistoryTagPage } from "./history-tags.js";
import { createMctxSettingsProvider } from "./settings.js";
import type { MctxToolDefinition } from "./status-metrics.js";
import { openMctxStatusSurface } from "./status-surface.js";
import { stripMctxTagPrefix } from "./tag-prefix.js";
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
		) => Promise<{ readonly messages: readonly AgentMessage[] } | undefined>,
	): void;
}

/** Pi event transport for an inline reminder; feature owns all admission policy. */
export function appendMctxToolResultReminder(
	feature: Partial<MctxFeature>,
	event: ToolResultEvent,
	context: ExtensionContext,
): { readonly content?: ToolResultEvent["content"] } {
	const reminder = feature.onToolResult?.(event.toolName, event.content, context);
	return reminder === undefined
		? {}
		: { content: [...event.content, { type: "text", text: reminder }] };
}

/** Delivers one store-claimed ceiling nudge and releases the claim on host failure. */
export function deliverMctxCeilingNudge(
	feature: Partial<MctxFeature>,
	pi: Pick<ExtensionAPI, "sendMessage">,
	context: ExtensionContext,
	deliverAs: "steer" | "followUp",
): void {
	const nudge = feature.claimCeilingNudge?.(context);
	if (nudge === undefined) return;
	try {
		pi.sendMessage(
			{
				customType: "pi-mctx:ceiling-nudge",
				content: nudge.text,
				display: false,
				details: { kind: "ctx-reduce-ceiling-nudge" },
			},
			{ deliverAs },
		);
	} catch {
		feature.releaseCeilingNudge?.(nudge);
		return;
	}
	feature.completeCeilingNudge?.(nudge);
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
	pi.on("session_before_compact", async (event, context) => {
		if (feature.active() === undefined) return undefined;
		try {
			const result = await feature.compact(
				event.branchEntries,
				event.preparation.tokensBefore,
				context,
				event.reason === "manual",
				event.signal,
			);
			if (result.kind === "compaction") return { compaction: result.compaction };
			if (event.reason === "manual") {
				const reason =
					result.kind === "failed"
						? result.reason
						: result.kind === "inactive"
							? "MCTX runtime is inactive"
							: "MCTX context changed before compaction completed";
				context.ui.notify(`MCTX compact failed: ${reason}`, "error");
			}
		} catch (error: unknown) {
			// An active MCTX runtime owns compact failure semantics. Letting Pi create
			// a second summary after a failed MCTX projection would corrupt that ownership.
			if (event.reason === "manual")
				context.ui.notify(
					`MCTX compact failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
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
			const settingsProvider = createMctxSettingsProvider({
				modelOptions: hepiAuthenticatedModelSelectionOptions(context.extension.modelRegistry),
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
	registerContextHook(pi, feature);
	registerCompactionHook(pi, feature);
	// Pi /reload can replace this entry module during an active turn while its
	// dependency cache still exposes the prior feature object. Keep that one
	// transition harmless; a process restart loads the matching implementation.
	const reloadCompatibleFeature = feature as Partial<MctxFeature>;
	pi.on("before_agent_start", (event) => {
		const prompt = reloadCompatibleFeature.systemPrompt?.();
		return prompt === undefined
			? undefined
			: { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
	const onToolResult = pi.on as unknown as (
		event: "tool_result",
		handler: (
			event: ToolResultEvent,
			context: ExtensionContext,
		) => { content?: ToolResultEvent["content"] },
	) => void;
	onToolResult("tool_result", (event, context) => {
		const reminder = appendMctxToolResultReminder(reloadCompatibleFeature, event, context);
		deliverMctxCeilingNudge(reloadCompatibleFeature, pi, context, "steer");
		return reminder;
	});
	pi.on("agent_end", (_event, context) => {
		deliverMctxCeilingNudge(reloadCompatibleFeature, pi, context, "followUp");
	});
	pi.on("turn_end", (_event, context) => feature.onTurnEnd(context));
	pi.on("message_end", (event, context) => {
		if (event.message.role === "assistant" && "errorMessage" in event.message)
			reloadCompatibleFeature.recordProviderError?.(event.message.errorMessage, context);
		if (event.message.role !== "assistant") return undefined;
		return { message: stripMctxTagPrefix(event.message) };
	});
}
