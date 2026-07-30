export interface AdvisorDelta {
	readonly user: string;
	readonly assistant?: string;
	readonly tools?: readonly string[];
}
export interface PrimaryTurnEvent {
	readonly message: unknown;
	readonly toolResults?: readonly unknown[];
}
export interface ContextBudget {
	readonly contextWindow: number;
	readonly responseReserve: number;
}
const marker = "\n…[advisor context truncated]…\n";
const MAX_TOOL_RESULT_EVIDENCE_CHARS = 12_000;
const MAX_TOOL_EVIDENCE_CHARS = 48_000;
function fit(value: string, chars: number): string {
	if (value.length <= chars) return value;
	if (chars <= marker.length) return marker.slice(0, Math.max(0, chars));
	const contentChars = chars - marker.length;
	const head = Math.ceil(contentChars / 2);
	return value.slice(0, head) + marker + value.slice(value.length - Math.floor(contentChars / 2));
}
function json(value: unknown): string {
	try {
		const encoded = JSON.stringify(value, undefined, 2);
		return encoded === undefined ? String(value) : encoded;
	} catch {
		return String(value);
	}
}

function partText(part: unknown, diffCallIds: ReadonlySet<string> = new Set()): string {
	if (typeof part !== "object" || part === null) return "";
	if (!("type" in part) || typeof part.type !== "string") return "";
	if (part.type === "text" && "text" in part && typeof part.text === "string") return part.text;
	if (part.type === "toolCall") {
		const id = "id" in part && typeof part.id === "string" ? part.id : "";
		const name = "name" in part && typeof part.name === "string" ? part.name : "";
		if (diffCallIds.has(id))
			return `TOOL CALL ${name} (${id})\narguments omitted; diff in tool result`;
		const args = "arguments" in part ? json(part.arguments) : "{}";
		return `TOOL CALL ${name} (${id})\n${args}`;
	}
	return "";
}

function successfulDiff(result: unknown): string | undefined {
	if (
		typeof result !== "object" ||
		result === null ||
		!("toolName" in result) ||
		result.toolName !== "edit" ||
		("isError" in result && result.isError === true)
	)
		return undefined;
	if (!("details" in result) || typeof result.details !== "object" || result.details === null)
		return undefined;
	const diff = "diff" in result.details ? result.details.diff : undefined;
	return typeof diff === "string" && diff.trim().length > 0 ? diff : undefined;
}

function toolResultContent(content: unknown): string {
	if (typeof content === "string") return fit(content, MAX_TOOL_RESULT_EVIDENCE_CHARS);
	if (!Array.isArray(content)) return "";
	let evidence = "";
	for (const part of content) {
		const text = partText(part);
		if (text.length === 0) continue;
		const separator = evidence.length === 0 ? "" : "\n";
		const available = MAX_TOOL_RESULT_EVIDENCE_CHARS - evidence.length - separator.length;
		if (available <= 0) return `${evidence}${marker}`;
		if (text.length > available) return `${evidence}${separator}${fit(text, available)}`;
		evidence += `${separator}${text}`;
	}
	return evidence;
}

function toolResultEvidence(result: unknown): string {
	if (typeof result !== "object" || result === null)
		return fit(json(result), MAX_TOOL_RESULT_EVIDENCE_CHARS);
	const name =
		"toolName" in result && typeof result.toolName === "string" ? result.toolName : "unknown";
	const id =
		"toolCallId" in result && typeof result.toolCallId === "string" ? result.toolCallId : "unknown";
	const error = "isError" in result && result.isError === true ? "ERROR" : "OK";
	const diff = successfulDiff(result);
	const content = "content" in result ? result.content : undefined;
	const body = diff ? fit(diff, MAX_TOOL_RESULT_EVIDENCE_CHARS) : toolResultContent(content);
	return `TOOL RESULT ${name} (${id}) ${error}\n${body}`;
}

export function extractPrimaryTurnEvidence(event: PrimaryTurnEvent): {
	readonly assistant?: string;
	readonly tools: readonly string[];
} {
	const message = event.message;
	const diffCallIds = new Set(
		(event.toolResults ?? []).flatMap((result) => {
			if (successfulDiff(result) === undefined || typeof result !== "object" || result === null)
				return [];
			const id = "toolCallId" in result ? result.toolCallId : undefined;
			return typeof id === "string" ? [id] : [];
		}),
	);
	let assistant: string | undefined;
	if (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		message.role === "assistant" &&
		"content" in message
	) {
		const content = Array.isArray(message.content)
			? message.content
					.map((part) => partText(part, diffCallIds))
					.filter(Boolean)
					.join("\n")
			: "";
		if (content.length > 0) assistant = content;
	}
	const tools: string[] = [];
	let remainingToolChars = MAX_TOOL_EVIDENCE_CHARS;
	for (const result of event.toolResults ?? []) {
		if (remainingToolChars <= 0) break;
		const evidence = toolResultEvidence(result);
		if (evidence.length > remainingToolChars) {
			tools.push(fit(evidence, remainingToolChars));
			break;
		}
		tools.push(evidence);
		remainingToolChars -= evidence.length;
	}
	return { ...(assistant === undefined ? {} : { assistant }), tools };
}

export function estimateTokens(value: string): number {
	return Math.ceil((value.length / 3) * 1.15);
}
export function contextInputCharBudget(budget: ContextBudget): number {
	const inputTokens =
		budget.contextWindow - budget.responseReserve - Math.ceil(budget.contextWindow * 0.1);
	if (inputTokens <= 0) throw new Error("Advisor context budget is too small");
	return Math.floor(((inputTokens * 3) / 1.15) * 0.5);
}
export function buildTurnDelta(
	user: string,
	assistant: string | undefined,
	tools: readonly string[] = [],
	budget: ContextBudget = { contextWindow: 32768, responseReserve: 4096 },
): AdvisorDelta {
	const available = contextInputCharBudget(budget);
	const requestedUserChars = Math.floor(available * 0.4);
	const requestedAssistantChars = Math.floor(available * 0.4);
	const userChars = Math.min(user.length, requestedUserChars);
	const assistantChars = Math.min(assistant?.length ?? 0, requestedAssistantChars);
	const toolChars = Math.max(0, available - userChars - assistantChars);
	const toolText = tools.join("\n");
	return {
		user: fit(user, userChars),
		...(assistant === undefined ? {} : { assistant: fit(assistant, assistantChars) }),
		...(toolText.length === 0 ? {} : { tools: [fit(toolText, toolChars)] }),
	};
}
export function buildReviewContext(
	history: readonly AdvisorDelta[],
	delta: AdvisorDelta,
	maxTurns = 8,
): string {
	const turns = [...history.slice(-Math.max(0, maxTurns - 1)), delta];
	return turns.map((turn, index) => `TURN ${index + 1}\n${buildSessionContext(turn)}`).join("\n\n");
}

export function buildSessionContext(delta: AdvisorDelta): string {
	return [
		"Primary turn review:",
		`USER:\n${delta.user}`,
		delta.assistant ? `ASSISTANT:\n${delta.assistant}` : "",
		delta.tools?.length ? `TOOLS:\n${delta.tools.join("\n")}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}
