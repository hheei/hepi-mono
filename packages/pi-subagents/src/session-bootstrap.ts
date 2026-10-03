import { randomUUID } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isRecord } from "@hheei/pi-ext-core";
import type {
	ModelRegistryLike,
	ParentAgentDefaults,
	SkillCatalogEntry,
} from "./agent-resolver.js";
import { resolveAgent } from "./agent-resolver.js";
import { builtinAgentToolProblem } from "./builtin-agents.js";
import type {
	EffectiveLaunchConfig,
	PersistenceState,
	PiInvocation,
	Presentation,
	ResolvedAgentPolicy,
	SpawnSubagentInput,
	SubagentRecord,
} from "./domain.js";
import { isSessionId } from "./domain.js";
import {
	assembleChildPrompt,
	resolveBridgeExtensionPath,
	resolvePiInvocation,
} from "./launch-spec.js";
import type { SubagentRegistry } from "./registry.js";

/** Bounded read for a session header; the first line holds the whole identity of the file. */
const HEADER_READ_BYTES = 64 * 1024;

export interface SessionPlacement {
	readonly sessionId: string;
	readonly sessionDir: string;
	/** Present only when a durable session file already exists for this id. */
	readonly sessionPath?: string;
	readonly persistence: PersistenceState;
}

export interface PlanSessionPlacementOptions {
	readonly sessionId: string;
	readonly cwd: string;
	readonly sessionDir?: string;
	readonly sessionPath?: string;
	readonly persistence?: PersistenceState;
}

export interface SessionFileIdentity {
	readonly sessionId: string;
	readonly cwd: string;
}

/**
 * The session directory Pi itself would use for this cwd. At the top level it holds the
 * human's own sessions, which is why children never write there directly.
 */
export function resolveDefaultSessionDir(cwd: string): string {
	return SessionManager.create(cwd).getSessionDir();
}

/** Child sessions live in this subdirectory of the parent-scoped session directory. */
const SUBAGENT_SESSION_DIR_NAME = "agents";

/**
 * The session directory a delegated child writes to.
 *
 * Pi discovers sessions with a non-recursive `readdir` of the session directory, so a
 * subdirectory keeps delegated sessions out of the human's session list while the child still
 * receives that directory as an explicit `--session-dir` recovery can find again.
 */
export function resolveSubagentSessionDir(cwd: string): string {
	return join(resolveDefaultSessionDir(cwd), SUBAGENT_SESSION_DIR_NAME);
}

async function readSessionHeader(path: string): Promise<SessionFileIdentity> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(HEADER_READ_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_BYTES, 0);
		const chunk = buffer.subarray(0, bytesRead).toString("utf8");
		const end = chunk.indexOf("\n");
		const line = (end === -1 ? chunk : chunk.slice(0, end)).trim();
		if (line === "") {
			throw new Error(`Session file ${path} has no header`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(`Session file ${path} has an unreadable header`, { cause: error });
		}
		if (!isRecord(parsed) || parsed.type !== "session") {
			throw new Error(`Session file ${path} is not a Pi session`);
		}
		if (typeof parsed.id !== "string" || !isSessionId(parsed.id)) {
			throw new Error(`Session file ${path} has an invalid session id`);
		}
		return { sessionId: parsed.id, cwd: typeof parsed.cwd === "string" ? parsed.cwd : "" };
	} finally {
		await handle.close();
	}
}

/** Verifies that a durable session file exists and still carries the expected identity. */
export async function inspectSessionFile(
	path: string,
	sessionId: string,
): Promise<SessionFileIdentity> {
	const header = await readSessionHeader(path);
	if (header.sessionId !== sessionId) {
		throw new Error(
			`Session file ${path} belongs to session ${header.sessionId}, not ${sessionId}`,
		);
	}
	return header;
}

/** Finds an already-flushed session file for an id. Empty files are not sessions yet. */
export async function findSessionFile(
	sessionDir: string,
	sessionId: string,
): Promise<string | undefined> {
	let names: string[];
	try {
		names = await readdir(sessionDir);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
	const candidates = names
		.filter((name) => name === `${sessionId}.jsonl` || name.endsWith(`_${sessionId}.jsonl`))
		.sort((left, right) => left.localeCompare(right));
	for (const name of candidates) {
		const path = join(sessionDir, name);
		const info = await stat(path);
		if (info.size === 0) continue;
		await inspectSessionFile(path, sessionId);
		return path;
	}
	return undefined;
}

/**
 * Decides whether a child session is already durable. A never-flushed session keeps
 * its recorded id and gets no path, so nothing can open an absent path and mint a
 * random id; a flushed session must still prove its identity on disk.
 */
export async function planSessionPlacement(
	options: PlanSessionPlacementOptions,
): Promise<SessionPlacement> {
	if (!isSessionId(options.sessionId)) {
		throw new Error(`Invalid session id ${options.sessionId}`);
	}
	const sessionDir = options.sessionDir ?? resolveSubagentSessionDir(options.cwd);
	const sessionPath = options.sessionPath;
	if (
		sessionPath !== undefined &&
		(await stat(sessionPath).then(
			() => true,
			() => false,
		))
	) {
		await inspectSessionFile(sessionPath, options.sessionId);
		return { sessionId: options.sessionId, sessionDir, sessionPath, persistence: "flushed" };
	}
	if (sessionPath !== undefined && options.persistence === "flushed") {
		throw new Error(`Recorded session file is missing: ${sessionPath}`);
	}
	const discovered = await findSessionFile(sessionDir, options.sessionId);
	if (discovered !== undefined) {
		return {
			sessionId: options.sessionId,
			sessionDir,
			sessionPath: discovered,
			persistence: "flushed",
		};
	}
	return { sessionId: options.sessionId, sessionDir, persistence: "never_flushed" };
}

let nextSubagentIndex = 0;

export function resetSubagentIdCounter(value = 0): void {
	nextSubagentIndex = value;
}

export function createSubagentId(existingIds?: readonly string[]): string {
	if (existingIds !== undefined && existingIds.length > 0) {
		let max = 0;
		for (const id of existingIds) {
			const match = /^agent-(\d+)$/u.exec(id);
			if (match?.[1]) {
				const num = Number.parseInt(match[1], 10);
				if (num > max) max = num;
			}
		}
		if (max > 0) {
			nextSubagentIndex = Math.max(nextSubagentIndex, max);
		}
	}
	nextSubagentIndex += 1;
	return `agent-${nextSubagentIndex}`;
}

export interface ResolveSubagentLaunchOptions {
	readonly input: SpawnSubagentInput;
	/** Parent agent cwd, used when the tool call does not ask for another one. */
	readonly cwd: string;
	readonly parent: ParentAgentDefaults;
	readonly modelRegistry: ModelRegistryLike;
	/** Parent's loaded skills, the catalog this launch's skill names resolve against. */
	readonly skillCatalog?: readonly SkillCatalogEntry[];
	/** Diagnostics for the caller to surface; omitted means they are dropped. */
	readonly onWarning?: (message: string) => void;
	readonly invocation?: PiInvocation;
	readonly bridgeExtensionPath?: string;
	readonly homeDirectory?: string;
	readonly subagentId?: string;
	readonly sessionId?: string;
	readonly existingSubagentIds?: readonly string[];
	readonly enforceEnabled?: boolean;
}

/**
 * One resolution chain for a spawn: agent definition + explicit parent defaults
 * become a single immutable, non-secret launch configuration. Child and session ids
 * are minted here, before any process exists.
 */
export async function resolveSubagentLaunch(
	options: ResolveSubagentLaunchOptions,
): Promise<EffectiveLaunchConfig> {
	const task = options.input.task.trim();
	if (task === "") throw new Error("spawn_agent requires a non-empty task");
	const name = options.input.agent?.trim();
	if (name === undefined || name === "") {
		throw new Error(
			"spawn_agent requires an explicit agent name; V1 has no built-in default agent",
		);
	}
	const cwd = resolve(options.input.cwd?.trim() || options.cwd);
	const requestedTitle = options.input.title?.trim();
	// A blank title is the same as no title: the child derives one from its own identity.
	const title = requestedTitle === "" ? undefined : requestedTitle;
	const subagentId = options.subagentId ?? createSubagentId(options.existingSubagentIds);
	const sessionId = options.sessionId ?? randomUUID();
	const bridgeExtensionPath = options.bridgeExtensionPath ?? resolveBridgeExtensionPath();
	const policy = await resolveAgent({
		name,
		cwd,
		modelRegistry: options.modelRegistry,
		parent: options.parent,
		bridgeExtensionPath,
		...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
		...(options.skillCatalog === undefined ? {} : { skillCatalog: options.skillCatalog }),
		...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
	});
	if (options.enforceEnabled === true && policy.enabled === false) {
		throw new Error(
			`Agent "${policy.agent.name}" is disabled: no model is specified in user configuration (~/.pi/agent/agents/ or .pi/agents/)`,
		);
	}
	return Object.freeze({
		subagentId,
		invocation: options.invocation ?? resolvePiInvocation(),
		cwd,
		sessionId,
		sessionDir: resolveSubagentSessionDir(cwd),
		agent: policy.agent,
		model: policy.model,
		thinking: policy.thinking,
		tools: childTools(policy),
		excludeTools: policy.excludeTools,
		extensions: policy.extensions,
		skills: policy.skills,
		prompt: assembleChildPrompt(policy.agent.instructions),
		bridgeExtensionPath,
		interactive: policy.interactive,
		...(title === undefined ? {} : { title }),
	});
}

/**
 * The child's tool allowlist: a built-in agent must still resolve to exactly the tools its
 * definition declares. Failing here happens before any process exists, rather than launching
 * a child with different permissions than it advertises.
 */
function childTools(policy: ResolvedAgentPolicy): readonly string[] {
	const tools = policy.tools;
	const problem = builtinAgentToolProblem(policy.agent.sourcePath, tools);
	if (problem !== undefined) {
		throw new Error(`Built-in agent ${policy.agent.name} cannot run: ${problem}`);
	}
	return tools;
}

export interface PersistSubagentIntentOptions {
	readonly registry: SubagentRegistry;
	readonly parentSessionId: string;
	readonly task: string;
	readonly launchConfig: EffectiveLaunchConfig;
	readonly presentation?: Presentation;
	readonly now?: () => Date;
}

/**
 * Writes the spawn intent before anything is launched. Registry failure propagates,
 * so a child is never started from intent that could not be recovered.
 */
export async function persistSubagentIntent(
	options: PersistSubagentIntentOptions,
): Promise<SubagentRecord> {
	const task = options.task.trim();
	if (task === "") throw new Error("Cannot persist a spawn intent without a task");
	if (options.registry.parentSessionId !== options.parentSessionId) {
		throw new Error(
			`Registry belongs to parent session ${options.registry.parentSessionId}, not ${options.parentSessionId}`,
		);
	}
	const { launchConfig } = options;
	const placement = await planSessionPlacement({
		sessionId: launchConfig.sessionId,
		cwd: launchConfig.cwd,
		sessionDir: launchConfig.sessionDir,
		...(launchConfig.sessionPath === undefined ? {} : { sessionPath: launchConfig.sessionPath }),
	});
	const timestamp = (options.now ?? ((): Date => new Date()))().toISOString();
	return options.registry.create({
		subagentId: launchConfig.subagentId,
		parentSessionId: options.parentSessionId,
		revision: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
		sessionId: placement.sessionId,
		...(placement.sessionPath === undefined ? {} : { sessionPath: placement.sessionPath }),
		cwd: launchConfig.cwd,
		initialTask: task,
		intent: "active",
		state: "starting",
		presentation: options.presentation ?? "background",
		persistence: placement.persistence,
		launchConfig: Object.freeze({
			...launchConfig,
			...(placement.sessionPath === undefined ? {} : { sessionPath: placement.sessionPath }),
		}),
		unacknowledgedInput: task,
	});
}
