import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CAVEMAN_INTENSITIES, type CavemanMode } from "./mode.js";
import { buildCavemanPrompt } from "./prompt.js";

export const CAVEMAN_SUBAGENT_MARKER = "<pi-caveman-subagent>";
const CAVEMAN_SUBAGENT_END_MARKER = "</pi-caveman-subagent>";
const PI_SUBAGENT_SESSION_SUFFIX = /#[0-9a-f]{8}$/i;
const PI_SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
	"Agent",
	"get_subagent_result",
	"steer_subagent",
]);
const COMPLETE_SUBAGENT_MARKERS = CAVEMAN_INTENSITIES.map(
	(mode) =>
		`${CAVEMAN_SUBAGENT_MARKER}\n${buildCavemanPrompt(mode)}\n${CAVEMAN_SUBAGENT_END_MARKER}`,
);

export interface AgentToolInput {
	prompt: string;
}

export function isPiSubagentSession(pi: ExtensionAPI): boolean {
	const sessionName = pi.getSessionName();
	if (sessionName === undefined || !PI_SUBAGENT_SESSION_SUFFIX.test(sessionName)) return false;
	return !pi.getAllTools().some((tool) => PI_SUBAGENT_TOOL_NAMES.has(tool.name));
}

export function isAgentToolInput(value: unknown): value is AgentToolInput {
	return (
		typeof value === "object" && value !== null && typeof Reflect.get(value, "prompt") === "string"
	);
}

export function injectSubagentPrompt(prompt: string, mode: CavemanMode): string {
	const instructions = buildCavemanPrompt(mode);
	if (instructions === undefined || hasSubagentPromptMarker(prompt)) return prompt;
	return `${prompt}\n\n${CAVEMAN_SUBAGENT_MARKER}\n${instructions}\n${CAVEMAN_SUBAGENT_END_MARKER}`;
}

export function hasSubagentPromptMarker(prompt: string): boolean {
	return COMPLETE_SUBAGENT_MARKERS.some((marker) => prompt.includes(marker));
}
