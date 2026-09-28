/**
 * Built-in agent definitions.
 *
 * These ship inside the package so a fresh install has a usable read-only agent without
 * writing anything into the user's home. A user definition at the same name always wins,
 * because discovery only falls back here after every filesystem scope has been searched.
 */
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { DiscoveredAgent } from "./agent-resolver.js";

/**
 * A synthetic path, not a file: it names the definition in errors and UI without pretending
 * to be an editable location.
 */
export const BUILTIN_AGENT_PREFIX = "<builtin>/";

/**
 * The tools the scout must keep: reading and searching, plus the channel it reports on. Anything
 * missing is a configuration failure, not a shrug.
 */
export const SCOUT_REQUIRED_TOOLS = ["read", "grep", "find", "ls", "contact_parent"] as const;

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
- Report progress and blockers to the parent with contact_parent. Keep progress reports short; the parent does not poll you.
- Finish by reporting your findings: a Task execution submits them with submit_task_result as the
  only tool call in that message, a conversation execution reports them with contact_parent.
`;

const DEFINITIONS: readonly string[] = [SCOUT_DEFINITION];

/** Reads the comma form and the YAML list form, so a built-in definition may use either. */
function toolNames(value: unknown): string[] {
	let names: readonly string[] = [];
	if (typeof value === "string") {
		names = value.split(",");
	} else if (Array.isArray(value)) {
		names = value.filter((entry): entry is string => typeof entry === "string");
	}
	return names.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

let parsed: readonly DiscoveredAgent[] | undefined;

/** The built-in definitions, parsed once. A malformed constant is a build-time bug, not user input. */
export function builtinAgents(): readonly DiscoveredAgent[] {
	parsed ??= DEFINITIONS.map(parseDefinition);
	return parsed;
}

function parseDefinition(text: string): DiscoveredAgent {
	const { frontmatter, body } = parseFrontmatter(text);
	const name = frontmatter.name;
	if (typeof name !== "string" || name === "") {
		throw new Error("Built-in agent definition has no name");
	}
	const declared = toolNames(frontmatter.tools);
	// An empty `tools` list means "every tool" downstream, which is the opposite of what a
	// built-in read-only agent promises, so the definition is rejected rather than widened.
	if (declared.length === 0) {
		throw new Error(`Built-in agent ${name} must name the tools it may use`);
	}
	const missing = SCOUT_REQUIRED_TOOLS.filter((tool) => !declared.includes(tool));
	if (missing.length > 0) {
		throw new Error(
			`Built-in agent ${name} must keep its required tools; missing: ${missing.join(", ")}`,
		);
	}
	return { name, path: `${BUILTIN_AGENT_PREFIX}${name}.md`, frontmatter, body };
}

/**
 * Why a resolved tool allowlist would break a built-in agent's promise, or `undefined` when it
 * does not. A built-in ships exactly the tools it names, so an allowlist that lost them, gained
 * others, or became empty (which Pi reads as "every tool") would give the agent different powers
 * than its definition advertises; resolution fails instead. `additionallyAllowed` names the one
 * extra channel a Task child must have.
 */
export function builtinAgentToolProblem(
	sourcePath: string,
	tools: readonly string[],
	additionallyAllowed: readonly string[] = [],
): string | undefined {
	const definition = builtinAgents().find((agent) => agent.path === sourcePath);
	if (definition === undefined) return undefined;
	if (tools.length === 0) {
		return "its tool list was lost, which would give it every tool";
	}
	const declared = toolNames(definition.frontmatter.tools);
	const missing = declared.filter((tool) => !tools.includes(tool));
	if (missing.length > 0) {
		return `tools it declares are missing: ${missing.join(", ")}`;
	}
	const gained = tools.filter(
		(tool) => !declared.includes(tool) && !additionallyAllowed.includes(tool),
	);
	if (gained.length > 0) {
		return `it would gain tools it never declared: ${gained.join(", ")}`;
	}
	return undefined;
}
