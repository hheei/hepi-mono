/**
 * Built-in agent definitions.
 *
 * These ship inside the package so a fresh install has usable roles without writing anything
 * into the user's home: reconnaissance, implementation, and review. A user definition at the
 * same name always wins, because discovery only falls back here after every filesystem scope
 * has been searched.
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

/** The tools a worker must keep: it exists to change code and to say what it changed. */
export const WORKER_REQUIRED_TOOLS = ["read", "edit", "write", "bash", "contact_parent"] as const;

/** The tools a reviewer must keep: it reads the code, runs the checks, and reports. */
export const REVIEWER_REQUIRED_TOOLS = ["read", "grep", "bash", "contact_parent"] as const;

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

const WORKER_DEFINITION = `---
name: worker
description: Carries out an implementation task in the repository and reports what it changed.
hidden: false
tools: read,grep,find,ls,bash,edit,write,contact_parent
---

You are a worker. Carry out the task in the repository you were given, and report what you did.

Rules:
- Read the surrounding code and the repository's own conventions before you edit. Keep the change
  focused on the task; do not refactor unrelated code.
- Run the focused checks the change needs (tests, typecheck, lint) and report their real output,
  including failures. Do not describe a check you did not run.
- Do not commit, push, or open a pull request unless the task asks for it explicitly.
- Report progress and blockers to the parent with contact_parent. Keep progress reports short; the
  parent does not poll you.
- Finish by reporting what changed, what you verified, and what you could not verify: a Task
  execution submits that with submit_task_result as the only tool call in that message, a
  conversation execution reports it with contact_parent.
`;

const REVIEWER_DEFINITION = `---
name: reviewer
description: Reviews code or a change and reports findings, using the review skills it is given.
hidden: false
skills: true
tools: read,grep,find,ls,bash,contact_parent
---

You are a reviewer. Inspect what you were pointed at and report findings. Do not change files unless
the task asks you to fix what you find.

Rules:
- Ground every finding in a file path and the line you read. If you could not verify something, say
  so instead of guessing.
- Order findings by severity and report the smallest set of real defects, risks and simplifications.
  A padded list costs the parent more than it tells it.
- When the code-review skill is listed in your prompt and the task is a review of a change, follow
  it: review along its two axes (the repository's own standards, and the spec the change came from)
  and report them separately, as the skill describes.
- When the ponytail-review skill is listed and the question is whether something is over-engineered,
  follow it: one line per finding — location, what to cut, what replaces it.
- Use bash to run the checks a finding depends on (tests, typecheck, a reproduction) and report the
  real output, not your expectation.
- A child cannot delegate further, so when a skill or a plan asks for parallel sub-agents, run those
  passes yourself instead of trying to spawn them, and say that is what you did.
- Report progress and blockers to the parent with contact_parent. Finish by reporting your findings:
  a Task execution submits them with submit_task_result as the only tool call in that message, a
  conversation execution reports them with contact_parent.
`;

interface BuiltinDefinition {
	readonly text: string;
	/** Tools this definition must keep; losing one is a build-time bug, not a user's choice. */
	readonly requiredTools: readonly string[];
}

const DEFINITIONS: readonly BuiltinDefinition[] = [
	{ text: SCOUT_DEFINITION, requiredTools: SCOUT_REQUIRED_TOOLS },
	{ text: WORKER_DEFINITION, requiredTools: WORKER_REQUIRED_TOOLS },
	{ text: REVIEWER_DEFINITION, requiredTools: REVIEWER_REQUIRED_TOOLS },
];

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

function parseDefinition(definition: BuiltinDefinition): DiscoveredAgent {
	const { frontmatter, body } = parseFrontmatter(definition.text);
	const name = frontmatter.name;
	if (typeof name !== "string" || name === "") {
		throw new Error("Built-in agent definition has no name");
	}
	const declared = toolNames(frontmatter.tools);
	// An empty `tools` list means "every tool" downstream, which is the opposite of what a
	// built-in promises, so the definition is rejected rather than widened.
	if (declared.length === 0) {
		throw new Error(`Built-in agent ${name} must name the tools it may use`);
	}
	const missing = definition.requiredTools.filter((tool) => !declared.includes(tool));
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
