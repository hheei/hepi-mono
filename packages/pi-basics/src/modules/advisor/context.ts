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
function fit(value: string, chars: number): string {
	if (value.length <= chars) return value;
	const head = Math.ceil(chars / 2);
	return value.slice(0, head) + marker + value.slice(value.length - Math.floor(chars / 2));
}
function json(value: unknown): string {
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? String(value) : encoded;
	} catch {
		return String(value);
	}
}

function partText(part: unknown): string {
	if (typeof part !== "object" || part === null) return "";
	if (!("type" in part) || typeof part.type !== "string") return "";
	if (part.type === "text" && "text" in part && typeof part.text === "string") return part.text;
	if (part.type === "toolCall") {
		const id = "id" in part && typeof part.id === "string" ? part.id : "";
		const name = "name" in part && typeof part.name === "string" ? part.name : "";
		const args = "arguments" in part ? json(part.arguments) : "{}";
		return `TOOL CALL ${name} (${id})\n${args}`;
	}
	return "";
}

function toolResultEvidence(result: unknown): string {
	if (typeof result !== "object" || result === null) return json(result);
	const name =
		"toolName" in result && typeof result.toolName === "string" ? result.toolName : "unknown";
	const id =
		"toolCallId" in result && typeof result.toolCallId === "string" ? result.toolCallId : "unknown";
	const error = "isError" in result && result.isError === true ? "ERROR" : "OK";
	const content =
		"content" in result && Array.isArray(result.content)
			? result.content
					.map(partText)
					.filter((part) => part.length > 0)
					.join("\n")
			: "content" in result && typeof result.content === "string"
				? result.content
				: "";
	const details = "details" in result ? `\nDETAILS:\n${json(result.details)}` : "";
	return `TOOL RESULT ${name} (${id}) ${error}\n${content}${details}`;
}

export function extractPrimaryTurnEvidence(event: PrimaryTurnEvent): {
	readonly assistant?: string;
	readonly tools: readonly string[];
} {
	const message = event.message;
	let assistant: string | undefined;
	if (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		message.role === "assistant" &&
		"content" in message
	) {
		const content = Array.isArray(message.content)
			? message.content.map(partText).filter(Boolean).join("\n")
			: "";
		if (content.length > 0) assistant = content;
	}
	return {
		...(assistant === undefined ? {} : { assistant }),
		tools: (event.toolResults ?? []).map(toolResultEvidence),
	};
}

export function estimateTokens(value: string): number {
	return Math.ceil((value.length / 3) * 1.15);
}
export function buildTurnDelta(
	user: string,
	assistant: string | undefined,
	tools: readonly string[] = [],
	budget: ContextBudget = { contextWindow: 32768, responseReserve: 4096 },
): AdvisorDelta {
	const available = Math.max(
		1024,
		Math.floor(((budget.contextWindow - budget.responseReserve) * 0.9 * 3) / 1.15),
	);
	const userChars = Math.floor(available * 0.4),
		assistantChars = Math.floor(available * 0.4),
		toolChars = Math.max(0, available - userChars - assistantChars);
	return {
		user: fit(user, userChars),
		...(assistant === undefined ? {} : { assistant: fit(assistant, assistantChars) }),
		tools: tools.map((item) => fit(item, Math.floor(toolChars / Math.max(1, tools.length)))),
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
