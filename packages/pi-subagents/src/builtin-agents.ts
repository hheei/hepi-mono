/**
 * Built-in agent definitions.
 *
 * These ship inside the package so a fresh install has a usable read-only agent without
 * writing anything into the user's home. A user definition at the same name always wins,
 * because discovery only falls back here after every filesystem scope has been searched.
 */
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
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

/** Reads the comma form and the YAML list form, so a built-in definition may use either. */
function toolNames(value: unknown): string[] {
	const names =
		typeof value === "string"
			? value.split(",")
			: Array.isArray(value)
				? value.filter((entry): entry is string => typeof entry === "string")
				: [];
	return names.map((entry) => entry.trim()).filter((entry) => entry !== "");
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

/**
 * Why a resolved tool allowlist would break a built-in agent's promise, or `undefined` when it
 * does not. A built-in ships a fixed read-only tool set; an allowlist that lost those tools, or
 * became empty (which Pi reads as "every tool"), would silently hand the agent far more power
 * than its definition advertises, so resolution fails instead.
 */
export function builtinAgentToolProblem(
	sourcePath: string,
	tools: readonly string[],
): string | undefined {
	if (!isBuiltinAgent(sourcePath)) return undefined;
	if (tools.length === 0) {
		return "its read-only tool list was lost, which would give it every tool";
	}
	const missing = SCOUT_REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
	if (missing.length > 0) {
		return `its required read-only tools are missing: ${missing.join(", ")}`;
	}
	return undefined;
}
