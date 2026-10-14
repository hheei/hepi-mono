import type { AgentToolResult, ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	agentResultText,
	createToolPresentationRenderers,
	isRecord,
	type ToolPresentationProvider,
} from "@hheei/pi-ext-core";
import { bashJobPurpose } from "./bg-bash-jobs.js";

/** Successful `bg_bash_spawn` details; the same id/path the model receives as JSON. */
export interface BashSpawnDetails {
	readonly id: string;
	readonly path: string;
}

function detailsRecord(
	result: AgentToolResult<unknown> | undefined,
): Record<string, unknown> | undefined {
	const details = result?.details;
	return isRecord(details) ? details : undefined;
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = source?.[key];
	return typeof value === "string" ? value : undefined;
}

function spawnDetails(result: AgentToolResult<unknown> | undefined): BashSpawnDetails | undefined {
	const details = detailsRecord(result);
	const id = stringField(details, "id");
	const path = stringField(details, "path");
	return id === undefined || path === undefined ? undefined : { id, path };
}

/**
 * Spawn shows the compact command as its header, the full command as the request, the assigned
 * id/path as human output, and copies the raw command plus the full result. A failed start has no
 * details, so the error text is the output and the UI keeps the error rail.
 */
export const bgBashSpawnPresentation: ToolPresentationProvider = (args, result) => {
	const command = isRecord(args) ? (stringField(args, "command") ?? "") : "";
	const details = spawnDetails(result);
	const resultText = result === undefined ? undefined : agentResultText(result);
	const output =
		details === undefined ? (resultText ?? "") : `id: ${details.id}\npath: ${details.path}`;
	const purpose = bashJobPurpose(command);
	const summary = details === undefined ? purpose : `${purpose} · ${details.id}`;
	return {
		summary,
		...(command === "" ? {} : { request: command }),
		...(output === "" ? {} : { output }),
		...(command === "" && resultText === undefined
			? {}
			: {
					copy: {
						primary: command,
						...(resultText === undefined
							? {}
							: { full: command === "" ? resultText : `${command}\n---\n${resultText}` }),
					},
				}),
	};
};

function progressLines(progress: Record<string, unknown>): string[] {
	const lines: string[] = [];
	const command = stringField(progress, "command");
	if (command !== undefined) lines.push(`command: ${command}`);
	const cwd = stringField(progress, "cwd");
	if (cwd !== undefined) lines.push(`cwd: ${cwd}`);
	const elapsed = progress.elapsedSeconds;
	if (typeof elapsed === "number") lines.push(`elapsed: ${String(elapsed)}s`);
	const path = stringField(progress, "path");
	if (path !== undefined) lines.push(`path: ${path}`);
	const output = stringField(progress, "output");
	if (output !== undefined && output !== "") lines.push("output:", ...output.split("\n"));
	if (progress.truncated === true) lines.push("truncated: true");
	return lines;
}

function getFieldLines(details: Record<string, unknown>): string[] {
	const lines: string[] = [];
	const status = stringField(details, "status");
	if (status !== undefined) lines.push(`status: ${status}`);
	const progress = details.progress;
	if (isRecord(progress)) lines.push(...progressLines(progress));
	const diagnostic = stringField(details, "diagnostic");
	if (diagnostic !== undefined) lines.push(`diagnostic: ${diagnostic}`);
	return lines;
}

function getCollapsedRow(details: Record<string, unknown> | undefined): string | undefined {
	if (details === undefined) return undefined;
	const parts: string[] = [];
	const status = stringField(details, "status");
	if (status !== undefined) parts.push(status);
	const progress = details.progress;
	if (isRecord(progress)) {
		const elapsed = progress.elapsedSeconds;
		if (typeof elapsed === "number") parts.push(`${String(elapsed)}s`);
	}
	const diagnostic = stringField(details, "diagnostic");
	if (diagnostic !== undefined) {
		parts.push(`diagnostic: ${diagnostic.replace(/\s+/gu, " ").trim()}`);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Get shows the queried id and keys as its header and renders only the fields the result actually
 * carries — status, bounded progress and diagnostic. It never re-adds the initial task arguments,
 * and it never parses the model text; the raw result is the copy payload.
 */
export const bgBashGetPresentation: ToolPresentationProvider = (args, result) => {
	const id = isRecord(args) ? (stringField(args, "id") ?? "") : "";
	const keys = isRecord(args) ? (stringField(args, "keys") ?? "") : "";
	const summary = id === "" ? "task" : keys === "" ? id : `${id} · ${keys}`;
	const details = detailsRecord(result);
	const lines = details === undefined ? [] : getFieldLines(details);
	const output =
		lines.length > 0 ? lines.join("\n") : result === undefined ? "" : agentResultText(result);
	const collapsedRow = getCollapsedRow(details);
	const resultText = result === undefined ? undefined : agentResultText(result);
	return {
		summary,
		...(output === "" ? {} : { output }),
		...(collapsedRow === undefined ? {} : { collapsedRows: [collapsedRow] }),
		...(resultText === undefined ? {} : { copy: { primary: resultText } }),
	};
};

/** Stop shows the target id and surfaces the confirmation or the raw failure reason. */
export const bgBashStopPresentation: ToolPresentationProvider = (args, result) => {
	const id = isRecord(args) ? (stringField(args, "id") ?? "") : "";
	const output = result === undefined ? "" : agentResultText(result);
	const primary = output !== "" ? output : id;
	return {
		summary: id === "" ? "stop task" : id,
		...(output === "" ? {} : { output }),
		...(primary === "" ? {} : { copy: { primary } }),
	};
};

export function bgBashPresentationRenderers(
	pi: ExtensionAPI,
	name: "bg_bash_spawn" | "bg_bash_get" | "bg_bash_stop",
): ToolRenderers {
	const provider =
		name === "bg_bash_spawn"
			? bgBashSpawnPresentation
			: name === "bg_bash_get"
				? bgBashGetPresentation
				: bgBashStopPresentation;
	return createToolPresentationRenderers(pi, name, provider);
}

export const backgroundBashRenderers = bgBashPresentationRenderers;
