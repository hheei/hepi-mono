import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerExtensionLifecycle } from "@hheei/pi-ext-core";
import { Type } from "typebox";
import { createMctxFeature } from "./feature.js";
import { MAX_CTX_EXPAND_CHARS, renderMctxHistoryTagPage } from "./history-tags.js";

interface PiContextHook {
	on(
		event: "context",
		handler: (
			event: { readonly messages: readonly AgentMessage[] },
			context: ExtensionContext,
		) => { readonly messages: readonly AgentMessage[] } | undefined,
	): void;
}

function registerContextHook(
	pi: ExtensionAPI,
	feature: ReturnType<typeof createMctxFeature>,
): void {
	// Pi exposes this runtime hook, but the installed public extension declaration omits it.
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

function registerHistoryTools(
	pi: ExtensionAPI,
	feature: ReturnType<typeof createMctxFeature>,
): void {
	pi.registerTool(
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
	pi.registerTool(
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
}

/**
 * Pi package entry. `turn_end` schedules historian work in the background;
 * `context` applies only already-verified compartments and never waits for it.
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
