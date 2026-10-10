import type { AgentToolResult, ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	agentResultText,
	createToolPresentationRenderers,
	isRecord,
	type ToolPresentation,
} from "@hheei/pi-ext-core";

/**
 * Owned presentations for the four parent-facing subagent tools. The native renderers keep the
 * model-visible text and raw errors when pi-ext-ui is absent; a loaded pi-ext-ui wraps the same
 * presentation through the ext-core provider registry, so both paths share one semantic source.
 */

export interface AgentSpawnDetails {
	readonly id: string;
	readonly path: string;
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = source?.[key];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function spawnPresentation(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
): ToolPresentation {
	const record = isRecord(args) ? args : undefined;
	const agent = stringField(record, "agent") ?? "agent";
	const title = stringField(record, "title");
	const task = stringField(record, "task");
	const details = result !== undefined && isRecord(result.details) ? result.details : undefined;
	const id = stringField(details, "id");
	const path = stringField(details, "path");
	const resultText = result === undefined ? undefined : agentResultText(result);
	const rows = [
		...(id === undefined ? [] : [`id: ${id}`]),
		...(path === undefined ? [] : [`path: ${path}`]),
	];
	return {
		summary: title === undefined ? agent : `${agent} · ${title}`,
		...(task === undefined ? {} : { request: task }),
		...(task === undefined
			? {}
			: {
					copy: {
						primary: task,
						full: resultText === undefined ? task : `${task}\n---\n${resultText}`,
					},
				}),
		...(rows.length === 0 ? {} : { output: rows.join("\n"), collapsedRows: rows }),
	};
}

function sendPresentation(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
): ToolPresentation {
	const record = isRecord(args) ? args : undefined;
	const id = stringField(record, "id") ?? "agent";
	const mode = stringField(record, "mode") ?? "auto";
	const message = stringField(record, "message");
	const confirmation = result === undefined ? undefined : agentResultText(result);
	const copy =
		message === undefined
			? undefined
			: {
					primary: message,
					...(confirmation === undefined ? {} : { full: `${message}\n${confirmation}` }),
				};
	return {
		summary: `${id} · ${mode}`,
		...(message === undefined ? {} : { request: message }),
		...(confirmation === undefined ? {} : { output: confirmation, collapsedRows: [confirmation] }),
		...(copy === undefined ? {} : { copy }),
	};
}

const PROGRESS_TEXT_KEYS = ["agent", "path", "presentation", "freshness", "activeTool"] as const;
const PROGRESS_NUMBER_KEYS = ["turns", "tokens"] as const;

/** Readable selected fields only; never restates the task or a terminal answer. */
function detailLines(details: Record<string, unknown>): string[] {
	const lines: string[] = [];
	const status = stringField(details, "status");
	if (status !== undefined) lines.push(`status: ${status}`);
	const progress = isRecord(details.progress) ? details.progress : undefined;
	if (progress !== undefined) {
		for (const key of PROGRESS_TEXT_KEYS) {
			const value = stringField(progress, key);
			if (value !== undefined) lines.push(`${key}: ${value}`);
		}
		for (const key of PROGRESS_NUMBER_KEYS) {
			const value = numberField(progress, key);
			if (value !== undefined) lines.push(`${key}: ${value}`);
		}
		const summary = stringField(progress, "summary");
		if (summary !== undefined) lines.push(`summary: ${summary}`);
	}
	const diagnostic = stringField(details, "diagnostic");
	if (diagnostic !== undefined) lines.push(`diagnostic: ${diagnostic}`);
	return lines;
}

function getPresentation(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
): ToolPresentation {
	const record = isRecord(args) ? args : undefined;
	const id = stringField(record, "id") ?? "agent";
	const keys = stringField(record, "keys") ?? "status, progress";
	const details = result !== undefined && isRecord(result.details) ? result.details : undefined;
	const lines = details === undefined ? [] : detailLines(details);
	const resultText = result === undefined ? undefined : agentResultText(result);
	return {
		summary: id,
		request: `keys: ${keys}`,
		...(lines.length === 0 ? {} : { output: lines.join("\n"), collapsedRows: lines }),
		...(resultText === undefined ? {} : { copy: { primary: resultText } }),
	};
}

function stopPresentation(
	args: unknown,
	result: AgentToolResult<unknown> | undefined,
): ToolPresentation {
	const record = isRecord(args) ? args : undefined;
	const id = stringField(record, "id") ?? "agent";
	const confirmation = result === undefined ? undefined : agentResultText(result);
	return {
		summary: id,
		...(confirmation === undefined ? {} : { output: confirmation, collapsedRows: [confirmation] }),
		...(confirmation === undefined ? {} : { copy: { primary: confirmation } }),
	};
}

/** One renderer set per tool, named exactly after its tool so nested calls resolve too. */
export function parentToolRenderers(pi: ExtensionAPI): {
	readonly spawn: ToolRenderers;
	readonly send: ToolRenderers;
	readonly get: ToolRenderers;
	readonly stop: ToolRenderers;
} {
	return {
		spawn: createToolPresentationRenderers(pi, "agent_spawn", spawnPresentation),
		send: createToolPresentationRenderers(pi, "agent_send", sendPresentation),
		get: createToolPresentationRenderers(pi, "agent_get", getPresentation),
		stop: createToolPresentationRenderers(pi, "agent_stop", stopPresentation),
	};
}
