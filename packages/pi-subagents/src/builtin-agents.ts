/**
 * Built-in agent definitions.
 *
 * These ship inside the package so a fresh install has a usable read-only agent without
 * writing anything into the user's home. A user definition at the same name always wins,
 * because discovery only falls back here after every filesystem scope has been searched.
 */
import { isRecord } from "@hheei/pi-ext-core";
import type { DiscoveredAgent } from "./agent-resolver.js";

/**
 * A synthetic path, not a file: it names the definition in errors and UI without pretending
 * to be an editable location.
 */
export const BUILTIN_AGENT_PREFIX = "<builtin>/";

/** Read-only tools the scout needs. Anything missing is a configuration failure, not a shrug. */
export const SCOUT_REQUIRED_TOOLS = ["read", "grep", "find", "ls"] as const;

const SCOUT_DEFINITION = `---
name: scout
description: Read-only reconnaissance of a codebase or a question, reported back to the parent.
hidden: false
tools: read,grep,find,ls,contact_parent
---

You are a read-only scout. Your job is to look things up and report exactly what you found.

Rules:
- Read and search only. You cannot write files, run commands, or change state; do not pretend otherwise.
- Ground every claim in a file path and the line you read. If you could not verify something, say so.
- Report findings to the parent with contact_parent. Keep progress reports short; the parent does not poll you.
- Finish with submit_task_result when the parent asked for a structured result; otherwise report the summary with contact_parent and stop.
`;

const DEFINITIONS: readonly string[] = [SCOUT_DEFINITION];

/** Splits `read,grep` and a YAML-style list into tool names. */
function toolNames(value: unknown): string[] {
	if (typeof value !== "string") return [];
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
	const normalized = text.replaceAll("\r\n", "\n");
	if (!normalized.startsWith("---\n"))
		throw new Error("Built-in agent definition has no frontmatter");
	const end = normalized.indexOf("\n---", 4);
	if (end === -1) throw new Error("Built-in agent definition has unterminated frontmatter");
	const frontmatter: Record<string, unknown> = {};
	for (const line of normalized.slice(4, end).split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const separator = trimmed.indexOf(":");
		if (separator <= 0) throw new Error(`Built-in agent definition has an invalid line: ${line}`);
		const key = trimmed.slice(0, separator).trim();
		const raw = trimmed.slice(separator + 1).trim();
		frontmatter[key] = raw === "true" ? true : raw === "false" ? false : raw;
	}
	return { frontmatter, body: normalized.slice(end + 4).trim() };
}

/** The built-in definitions, parsed once. A malformed constant is a build-time bug, not user input. */
export function builtinAgents(): readonly DiscoveredAgent[] {
	return DEFINITIONS.map((text) => {
		const parsed = parseFrontmatter(text);
		const name = parsed.frontmatter.name;
		if (typeof name !== "string" || name === "") {
			throw new Error("Built-in agent definition has no name");
		}
		if (!isRecord(parsed.frontmatter))
			throw new Error("Built-in agent frontmatter must be an object");
		// An empty `tools` list means "every tool" downstream, which is the opposite of what a
		// built-in read-only agent promises, so the definition is rejected rather than widened.
		if (toolNames(parsed.frontmatter.tools).length === 0) {
			throw new Error(`Built-in agent ${name} must name the tools it may use`);
		}
		return {
			name,
			path: `${BUILTIN_AGENT_PREFIX}${name}.md`,
			frontmatter: parsed.frontmatter,
			body: parsed.body,
		};
	});
}

/** True when a discovered definition comes from this package rather than from disk. */
export function isBuiltinAgent(path: string): boolean {
	return path.startsWith(BUILTIN_AGENT_PREFIX);
}
