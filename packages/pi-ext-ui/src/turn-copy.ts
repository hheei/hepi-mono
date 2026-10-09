import { stripTerminalSequences } from "@earendil-works/pi-tui";

export interface TurnToolCallSummary {
	readonly toolName: string;
	readonly commandOrArgs?: string | undefined;
	readonly summary: string;
}

export interface TurnFlowData {
	readonly userPrompt: string;
	readonly toolCalls?: readonly TurnToolCallSummary[] | undefined;
	readonly assistantReply: string;
}

export function formatTurnFlow(data: TurnFlowData): string {
	const blocks: string[] = [];
	const cleanUser = stripTerminalSequences(data.userPrompt).trim();
	blocks.push(`[User]\n${cleanUser}`);

	if (data.toolCalls !== undefined && data.toolCalls.length > 0) {
		const toolLines: string[] = [];
		for (const call of data.toolCalls) {
			const header =
				call.commandOrArgs !== undefined && call.commandOrArgs.trim() !== ""
					? `${call.toolName} ${stripTerminalSequences(call.commandOrArgs).trim()}`
					: call.toolName;
			const detail = stripTerminalSequences(call.summary).trim();
			toolLines.push(detail !== "" ? `${header}\n${detail}` : header);
		}
		blocks.push(`[Tools]\n${toolLines.join("\n\n")}`);
	}

	const cleanAssistant = stripTerminalSequences(data.assistantReply).trim();
	blocks.push(`[Assistant]\n${cleanAssistant}`);

	return blocks.join("\n\n");
}
