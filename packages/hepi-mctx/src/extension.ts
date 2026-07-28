import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import piMagicContext from "@hheei/pi-magic-context";
import {
	type HepiLoadoutGroup,
	registerHepiRuntimeLoadoutGroup,
} from "../../hepi-basics/src/core/index.js";
import { registerMagicContextSubagentAccounting } from "./subagent-accounting.js";

export type HepiExtension = (pi: ExtensionAPI) => void;

const MAGIC_CONTEXT_LOADOUT_GROUP = {
	id: "magic-context",
	label: "Magic Context",
	items: ["ctx_search", "ctx_expand", "ctx_memory", "ctx_note", "ctx_reduce", "todowrite"],
} as const satisfies HepiLoadoutGroup;

const CHANNEL1_REMINDER_MARKERS = [
	"tokens of tool output you have not reduced",
	"tokens of unreduced tool output",
] as const;

interface ReminderBridgeState {
	current: symbol | undefined;
	readonly pendingBySessionId: Map<string, string[]>;
}

declare global {
	var __hepiMagicContextReminderBridgeStates: WeakMap<object, ReminderBridgeState> | undefined;
}

function getReminderBridgeState(events: object): ReminderBridgeState {
	let states = globalThis.__hepiMagicContextReminderBridgeStates;
	if (states === undefined) {
		states = new WeakMap();
		globalThis.__hepiMagicContextReminderBridgeStates = states;
	}
	const existing = states.get(events);
	if (existing !== undefined) return existing;
	const created: ReminderBridgeState = {
		current: undefined,
		pendingBySessionId: new Map(),
	};
	states.set(events, created);
	return created;
}

function textFromContentPart(part: unknown): string | undefined {
	if (typeof part === "string") return part;
	if (
		part !== null &&
		typeof part === "object" &&
		"type" in part &&
		part.type === "text" &&
		"text" in part &&
		typeof part.text === "string"
	) {
		return part.text;
	}
	return undefined;
}

function isChannel1Reminder(part: unknown): boolean {
	const text = textFromContentPart(part);
	return (
		text?.includes("<system-reminder>") === true &&
		text.includes("ctx_reduce") &&
		CHANNEL1_REMINDER_MARKERS.some((marker) => text.includes(marker))
	);
}

/** Keeps Magic Context housekeeping instructions out of persisted tool results. */
function registerMagicContextReminderBridge(pi: ExtensionAPI): void {
	const state = getReminderBridgeState(pi.events);
	const token = Symbol("magic-context-reminder-bridge");
	state.current = token;
	const isCurrent = (): boolean => state.current === token;

	pi.on("tool_result", async (event, ctx) => {
		if (!isCurrent()) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const reminders = event.content
			.filter(isChannel1Reminder)
			.map((part) => textFromContentPart(part))
			.filter((text): text is string => text !== undefined);
		if (reminders.length === 0) return;
		const pending = state.pendingBySessionId.get(sessionId) ?? [];
		pending.push(...reminders);
		state.pendingBySessionId.set(sessionId, pending);
		return { content: event.content.filter((part) => !isChannel1Reminder(part)) };
	});

	pi.on("context", async (event, ctx) => {
		if (!isCurrent()) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const reminders = state.pendingBySessionId.get(sessionId);
		if (reminders === undefined || reminders.length === 0) return;
		state.pendingBySessionId.delete(sessionId);
		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					customType: "hepi-mctx-context-reminder",
					content: reminders.join("\n\n"),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (isCurrent()) state.pendingBySessionId.delete(ctx.sessionManager.getSessionId());
	});
}

function hasConfiguredMagicContext(): boolean {
	try {
		const settings: unknown = JSON.parse(
			readFileSync(join(getAgentDir(), "settings.json"), "utf8"),
		);
		if (!settings || typeof settings !== "object" || !("packages" in settings)) return false;
		const packages = settings.packages;
		if (!Array.isArray(packages)) return false;
		return packages.some(isMagicContextPackage);
	} catch {
		return false;
	}
}

export function isMagicContextPackage(entry: unknown): boolean {
	const source =
		typeof entry === "string"
			? entry
			: entry !== null && typeof entry === "object" && "source" in entry
				? entry.source
				: undefined;
	if (typeof source !== "string") return false;
	const name = source.startsWith("npm:") ? source.slice("npm:".length) : source;
	return (
		name === "@hheei/pi-magic-context" ||
		name.startsWith("@hheei/pi-magic-context@") ||
		name === "@cortexkit/pi-magic-context" ||
		name.startsWith("@cortexkit/pi-magic-context@")
	);
}

function registerBundledMagicContext(pi: ExtensionAPI): void {
	const toolNames = new Set<string>();
	const groupedPi: ExtensionAPI = {
		...pi,
		registerTool: (tool) => {
			pi.registerTool(tool);
			toolNames.add(tool.name);
		},
	};
	piMagicContext(groupedPi);
	registerHepiRuntimeLoadoutGroup(
		pi,
		toolNames.size === 0
			? MAGIC_CONTEXT_LOADOUT_GROUP
			: { ...MAGIC_CONTEXT_LOADOUT_GROUP, items: [...toolNames] },
	);
}

const hasExternalMagicContext = hasConfiguredMagicContext();

const registerExternalMagicContextLoadout: HepiExtension = (pi) => {
	if (hasExternalMagicContext) registerHepiRuntimeLoadoutGroup(pi, MAGIC_CONTEXT_LOADOUT_GROUP);
};

export const hepiMctxExtensions: readonly HepiExtension[] = [
	registerExternalMagicContextLoadout,
	...(hasExternalMagicContext ? [] : [registerBundledMagicContext]),
	registerMagicContextReminderBridge,
	registerMagicContextSubagentAccounting,
];

export default function piHepiMctxExtension(pi: ExtensionAPI): void {
	for (const extension of hepiMctxExtensions) extension(pi);
}
