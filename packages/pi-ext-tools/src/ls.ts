import {
	type AgentToolResult,
	createLsToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	agentResultText,
	createToolTui,
	formatDuration,
	registerManagedTool,
	type ToolCompletion,
	type ToolTui,
} from "@hheei/pi-ext-core";
import { counted } from "./counted.js";

const OWNER = "@hheei/pi-ext-tools";

export interface LsMetrics {
	readonly total: number;
	readonly directories: number;
	readonly files: number;
	readonly empty: boolean;
	readonly truncated: boolean;
}

export function parseLsMetrics(text: string): LsMetrics {
	const trimmed = text.trim();
	if (trimmed === "" || trimmed === "(empty directory)") {
		return { total: 0, directories: 0, files: 0, empty: true, truncated: false };
	}
	let directories = 0;
	let files = 0;
	let truncated = false;
	const lines = trimmed.split("\n");
	for (const line of lines) {
		const entry = line.trim();
		if (!entry) continue;
		if (
			entry.startsWith("[") &&
			entry.endsWith("]") &&
			(entry.includes("Truncated") || entry.includes("truncated"))
		) {
			truncated = true;
			continue;
		}
		if (entry.endsWith("/")) {
			directories += 1;
		} else {
			files += 1;
		}
	}
	const total = directories + files;
	return {
		total,
		directories,
		files,
		empty: total === 0,
		truncated,
	};
}

export function lsCollapsedFooter(
	result: AgentToolResult<unknown>,
	completion: ToolCompletion | undefined,
): string | undefined {
	const text = agentResultText(result);
	const metrics = parseLsMetrics(text);
	const duration = formatDuration(completion?.durationMs);

	if (metrics.empty) {
		return ["(empty directory)", duration].filter(Boolean).join(" · ");
	}

	const parts: string[] = [];
	if (metrics.truncated) {
		parts.push(`${metrics.total} entries (truncated)`);
	} else if (metrics.directories > 0 && metrics.files > 0) {
		parts.push(
			`${counted(metrics.total, "entry", "entries")} (${counted(metrics.directories, "dir")}, ${counted(metrics.files, "file")})`,
		);
	} else if (metrics.directories > 0) {
		parts.push(counted(metrics.directories, "dir"));
	} else {
		parts.push(counted(metrics.files, "file"));
	}

	if (duration) parts.push(duration);
	return parts.join(" · ");
}

/** Register Pi's directory listing with native ToolTui framing and collapsible summary. */
export function registerLsTool(pi: ExtensionAPI, tui: ToolTui = createToolTui()) {
	const tool = createLsToolDefinition(process.cwd());
	registerManagedTool(
		pi,
		{
			id: "ls",
			owner: OWNER,
		},
		tui.frame(tool, {
			summary: (args) => {
				const path = typeof args?.path === "string" ? args.path.trim() : "";
				return path || ".";
			},
			footer: lsCollapsedFooter,
			longOutput: true,
			maxBodyLines: Number.POSITIVE_INFINITY,
		}),
	);
	return tool;
}
