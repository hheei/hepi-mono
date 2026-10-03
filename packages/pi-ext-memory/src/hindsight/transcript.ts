import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, UserMessage } from "@earendil-works/pi-ai";

/** One retained conversational turn. */
export interface HindsightTurn {
	readonly role: "user" | "assistant";
	readonly text: string;
}

/** Longest single-line tool/argument summary kept in a retained turn. */
export const MAX_TOOL_ACTION_CHARS = 160;
/** Longest retained user/assistant turn. */
export const MAX_TURN_CHARS = 4_000;

/**
 * Matches the memory container this extension injects into the system prompt.
 *
 * Injected content is escaped so it cannot close the container early, so a lazy match
 * over real tags is sufficient and cannot be steered by recalled text.
 */
const MEMORY_CONTAINER_PATTERN =
	/<(?:memory|hindsight-recall)>[\s\S]*?<\/(?:memory|hindsight-recall)>\s*/g;

const ARG_SUMMARY_KEYS = [
	"command",
	"path",
	"file_path",
	"pattern",
	"query",
	"id",
	"ids",
	"target",
	"url",
] as const;

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Removes injected memory containers so retained turns cannot feed back into memory. */
export function stripMemoryContainers(text: string): string {
	return text.replace(MEMORY_CONTAINER_PATTERN, "");
}

function textFromUserContent(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((part) => (part.type === "text" ? part.text : "[image]"))
		.filter((part) => part.length > 0)
		.join("\n");
}

function summarizeArguments(args: Record<string, unknown>): string {
	for (const key of ARG_SUMMARY_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim().length > 0) return oneLine(value);
		if (Array.isArray(value) && value.length > 0) {
			const joined = value.filter((item) => typeof item === "string").join(" ");
			if (joined.length > 0) return oneLine(joined);
		}
	}
	return "";
}

function toolActionLine(call: ToolCall): string {
	const summary = summarizeArguments(call.arguments);
	return truncate(
		summary.length > 0 ? `action: ${call.name} ${summary}` : `action: ${call.name}`,
		MAX_TOOL_ACTION_CHARS,
	);
}

function textFromAssistantContent(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text.trim().length > 0) parts.push(block.text);
		else if (block.type === "toolCall") parts.push(toolActionLine(block));
	}
	return parts.join("\n");
}

/**
 * Normalizes a Pi transcript into the compact user/assistant turns worth retaining.
 *
 * Tool results, injected memory containers, thinking blocks, and empty messages are
 * dropped: Hindsight retains what was decided and asked, not the raw evidence trail,
 * which the session itself can still replay. A failed or aborted assistant response is
 * dropped too — an interrupted run is not a durable fact, and pi retries it.
 */
export function buildHindsightTurns(messages: readonly AgentMessage[]): HindsightTurn[] {
	const turns: HindsightTurn[] = [];
	for (const message of messages) {
		const role = (message as { role?: unknown }).role;
		if (role !== "user" && role !== "assistant") continue;
		if (role === "assistant") {
			const stopReason = (message as AssistantMessage).stopReason;
			if (stopReason === "error" || stopReason === "aborted") continue;
		}
		const raw =
			role === "user"
				? textFromUserContent((message as UserMessage).content)
				: textFromAssistantContent(message as AssistantMessage);
		const text = truncate(stripMemoryContainers(raw).trim(), MAX_TURN_CHARS);
		if (text.length === 0) continue;
		turns.push({ role, text });
	}
	return turns;
}

/** Stable identity for a retained turn prefix, used to skip redundant retain calls. */
export function fingerprintTurns(turns: readonly HindsightTurn[], count = turns.length): string {
	const hash = createHash("sha256").update(String(count));
	for (let index = 0; index < count; index += 1) {
		const turn = turns[index];
		if (turn === undefined) continue;
		hash.update(`\n${turn.role}\u0000${turn.text}`);
	}
	return hash.digest("hex");
}

/** Renders turns as the plain transcript body sent to Hindsight. */
export function renderHindsightTranscript(turns: readonly HindsightTurn[]): string {
	return turns
		.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)
		.join("\n\n");
}
