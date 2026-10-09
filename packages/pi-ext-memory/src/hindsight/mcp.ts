import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "@hheei/pi-ext-core";

export const HINDSIGHT_MCP_SERVER_NAME = "hindsight";

/**
 * Standard interactive tools exposed directly to the model.
 * All other tools discovered from the server receive deferred exposure.
 */
export const HINDSIGHT_MCP_DIRECT_TOOLS = [
	"get_knowledge_base_tree",
	"search_knowledge_base",
	"get_knowledge_page",
	"recall",
	"reflect",
	"retain",
] as const;

export const HINDSIGHT_MCP_TOOL_EXPOSURES: Readonly<Record<string, "direct">> = Object.freeze(
	Object.fromEntries(HINDSIGHT_MCP_DIRECT_TOOLS.map((tool) => [tool, "direct" as const])),
);

/**
 * MCP per-request timeout in seconds.
 * Sized to accommodate deep memory reflection and synthesis (~45s), exceeding the host default 30s.
 */
export const HINDSIGHT_MCP_TIMEOUT_SECONDS = 60;

/**
 * Determines whether an MCP tool is a state-mutating write tool that should trigger
 * recall cache invalidation upon successful completion.
 *
 * Uses the tool's `readOnlyHint` annotation from `pi.getAllTools()` when available.
 * Conservatively, unknown tools without annotations are treated as writes rather than
 * assuming unlisted operations never mutate state.
 */
export function isHindsightWriteTool(
	toolName: string,
	allTools?: readonly { name: string; annotations?: { readOnlyHint?: boolean } }[],
): boolean {
	const prefix = `mcp__${HINDSIGHT_MCP_SERVER_NAME}__`;
	if (!toolName.startsWith(prefix)) return false;

	if (allTools) {
		const tool = allTools.find((t) => t.name === toolName);
		if (tool?.annotations?.readOnlyHint !== undefined) {
			return !tool.annotations.readOnlyHint;
		}
	}

	const name = toolName.slice(prefix.length);
	// Known read tools
	if (
		name === "recall" ||
		name === "reflect" ||
		name === "get_knowledge_base_tree" ||
		name === "get_knowledge_page" ||
		name === "search_knowledge_base"
	) {
		return false;
	}

	// Conservatively: unknown successful tools invalidate rather than assume never writes
	return true;
}

function checkErrorPayload(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.isError === true) return true;
	if (value.status === "error" || value.status === "failed") return true;
	if (value.error !== undefined && value.error !== null) return true;
	if (value.success === false) return true;
	return false;
}

function checkContentForError(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			const trimmed = block.text.trim();
			if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
				try {
					const parsed: unknown = JSON.parse(trimmed);
					if (checkErrorPayload(parsed)) return true;
				} catch {
					// Ignore invalid JSON
				}
			}
		}
	}
	return false;
}

/**
 * Checks whether a Hindsight tool result represents a failure, including MCP protocol errors,
 * wrapped `CallToolResult.structuredContent` payloads, and raw untruncated content.
 * Exported for sharing with tool renderers and result normalizers.
 */
export function isHindsightBusinessError(result: {
	isError?: boolean | undefined;
	structuredContent?: unknown;
	content?: readonly { type: string; text?: string }[] | undefined;
}): boolean {
	if (result.isError === true) return true;

	if (isRecord(result.structuredContent)) {
		const sc = result.structuredContent;
		if (sc.isError === true) return true;
		// Check wrapped business payload in CallToolResult: sc.structuredContent
		if (checkErrorPayload(sc.structuredContent)) return true;
		// Check top-level structuredContent fields (if unwrapped)
		if (checkErrorPayload(sc)) return true;
		// Check original untruncated content in CallToolResult: sc.content
		if (checkContentForError(sc.content)) return true;
	}

	// Check model-facing content (possibly truncated)
	if (checkContentForError(result.content)) return true;

	return false;
}

/**
 * Checks if a file-based MCP configuration (global or project mcp.json) defines a
 * "hindsight" server. File-based definitions take precedence in Pi host over extension
 * registrations, which could alter the expected bank routing.
 */
export async function checkMcpFileOverride(
	cwd: string,
	agentDir?: string,
): Promise<string | undefined> {
	const resolvedAgentDir = agentDir ?? getAgentDir();
	const candidates = [
		{ path: join(cwd, ".pi", "mcp.json"), label: ".pi/mcp.json" },
		{ path: join(resolvedAgentDir, "mcp.json"), label: "agent mcp.json" },
	];

	for (const candidate of candidates) {
		try {
			const text = await readFile(candidate.path, "utf-8");
			const parsed: unknown = JSON.parse(text);
			if (
				isRecord(parsed) &&
				isRecord(parsed.mcpServers) &&
				parsed.mcpServers[HINDSIGHT_MCP_SERVER_NAME] !== undefined
			) {
				return `overridden by ${candidate.label}`;
			}
		} catch {
			// File does not exist or unparseable; check next
		}
	}

	return undefined;
}
