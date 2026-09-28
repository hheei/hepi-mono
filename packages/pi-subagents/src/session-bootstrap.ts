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
	ExecutionMode,
	PersistenceState,
	PiInvocation,
	ResolvedAgentPolicy,
	SpawnSubagentInput,
	SubagentRecord,
} from "./domain.js";
import { isSessionId, TASK_RESULT_TOOL_NAME } from "./domain.js";
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
 * The Pi session directory a child would use by default for its cwd. It is asked
 * of Pi itself instead of re-deriving the layout, and is always passed to the child
 * as an explicit `--session-dir` so recovery can find the file again.
 */
export function resolveDefaultSessionDir(cwd: string): string {
	return SessionManager.create(cwd).getSessionDir();
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
	const sessionDir = options.sessionDir ?? resolveDefaultSessionDir(options.cwd);
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

export function createSubagentId(): string {
	return `sa_${randomUUID().replace(/-/gu, "").slice(0, 12)}`;
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
	if (task === "") throw new Error("spawn_subagent requires a non-empty task");
	const name = options.input.agent?.trim();
	if (name === undefined || name === "") {
		throw new Error(
			"spawn_subagent requires an explicit agent name; V1 has no built-in default agent",
		);
	}
	const cwd = resolve(options.input.cwd?.trim() || options.cwd);
	const subagentId = options.subagentId ?? createSubagentId();
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
	return Object.freeze({
		subagentId,
		invocation: options.invocation ?? resolvePiInvocation(),
		cwd,
		sessionId,
		sessionDir: resolveDefaultSessionDir(cwd),
		agent: policy.agent,
		model: policy.model,
		thinking: policy.thinking,
		tools: childTools(policy, options.input.taskContract !== undefined),
		excludeTools: policy.excludeTools,
		extensions: policy.extensions,
		skills: policy.skills,
		prompt: assembleChildPrompt(
			policy.agent.instructions,
			options.input.taskContract !== undefined,
		),
		bridgeExtensionPath,
		interactive: policy.interactive,
		...(options.input.taskContract === undefined ? {} : { task: options.input.taskContract }),
	});
}

/**
 * The child's tool allowlist: a Task child gets its result channel, and a built-in agent must
 * still resolve to exactly the tools its definition declares. Failing here happens before any
 * process exists, rather than launching a child with different permissions than it advertises.
 *
 * The resolved allowlist is also the effective one: the agent resolver rejects a definition whose
 * `tools` and `exclude_tools` overlap, and `exclude_tools` may not name the required bridge, so the
 * `--exclude-tools` list can only remove tools this list never granted.
 */
function childTools(policy: ResolvedAgentPolicy, isTask: boolean): readonly string[] {
	const tools = taskChildTools(policy.tools, policy.excludeTools, isTask);
	const problem = builtinAgentToolProblem(
		policy.agent.sourcePath,
		tools,
		isTask ? [TASK_RESULT_TOOL_NAME] : [],
	);
	if (problem !== undefined) {
		throw new Error(`Built-in agent ${policy.agent.name} cannot run: ${problem}`);
	}
	return tools;
}

/**
 * A Task child reports its result only through `submit_task_result`, so a tool allowlist that
 * omits it would make every such task fail without the child being able to say why. An empty
 * allowlist already means "all tools", so only a non-empty list needs the channel added.
 */
function taskChildTools(
	tools: readonly string[],
	excludeTools: readonly string[],
	isTask: boolean,
): readonly string[] {
	if (!isTask) return tools;
	if (excludeTools.includes(TASK_RESULT_TOOL_NAME)) {
		throw new Error(
			`exclude_tools cannot disable ${TASK_RESULT_TOOL_NAME}: it is the only channel for a Task child's final result`,
		);
	}
	if (tools.length === 0 || tools.includes(TASK_RESULT_TOOL_NAME)) return tools;
	return [...tools, TASK_RESULT_TOOL_NAME];
}

export interface PersistSubagentIntentOptions {
	readonly registry: SubagentRegistry;
	readonly parentSessionId: string;
	readonly task: string;
	readonly launchConfig: EffectiveLaunchConfig;
	readonly mode?: ExecutionMode;
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
		mode: options.mode ?? "rpc",
		persistence: placement.persistence,
		launchConfig: Object.freeze({
			...launchConfig,
			...(placement.sessionPath === undefined ? {} : { sessionPath: placement.sessionPath }),
		}),
		unacknowledgedInput: task,
	});
}
