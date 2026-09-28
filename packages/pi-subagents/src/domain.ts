import { isRecord } from "@hheei/pi-ext-core";

export const PROTOCOL_VERSION = 1 as const;
export const REGISTRY_VERSION = 1 as const;

export type SubagentState = "starting" | "running" | "idle" | "done" | "stopped" | "failed";
export type ExecutionMode = "rpc" | "tui";
export type SendMode = "steer" | "follow_up" | "auto";

export const SUBAGENT_GLYPH: Record<SubagentState, string> = {
	starting: "󰄰",
	running: "󰪠",
	idle: "󰄰",
	done: "󰄴",
	stopped: "󰅚",
	failed: "󰅚",
};

export const SUBAGENT_TONE: Record<
	SubagentState,
	"muted" | "warning" | "accent" | "success" | "dim" | "error"
> = {
	starting: "muted",
	running: "warning",
	idle: "accent",
	done: "success",
	failed: "error",
	stopped: "dim",
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type LaunchValueSource = "agent" | "parent";
export type SubagentIntent = "active" | "stopped";
export type PersistenceState = "never_flushed" | "flushed";

export interface ChildIdentity {
	readonly parentSessionId: string;
	readonly subagentId: string;
	readonly runtimeIdentity: string;
	readonly endpoint: string;
	readonly token: string;
}

/**
 * The non-secret half of {@link ChildIdentity}: what a launch spec may contain and
 * what may be persisted. The controller token is added by the launcher at spawn
 * time and never written to a registry snapshot.
 */
export interface ChildBridgeEnvironment {
	readonly parentSessionId: string;
	readonly subagentId: string;
	readonly runtimeIdentity: string;
	readonly endpoint: string;
}

export interface PiInvocation {
	/** Executable or runtime binary, never resolved through a shell. */
	readonly command: string;
	/** Host-resolved leading argv (for example an absolute `cli.js`). Feature flags are appended by the launch builder. */
	readonly args: readonly string[];
}

export interface ResolvedAgentIdentity {
	readonly name: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly hidden: boolean;
	readonly sourcePath: string;
	readonly instructions: string;
}

export interface ResolvedModel {
	readonly provider: string;
	readonly id: string;
	readonly source: LaunchValueSource;
}

export interface ResolvedThinking {
	readonly level: ThinkingLevel;
	readonly source: LaunchValueSource;
}

export interface Selection {
	readonly discovery: boolean;
	readonly paths: readonly string[];
}

/** Extensions and skills are selected the same way; the aliases keep the two roles named. */
export type ExtensionSelection = Selection;
export type SkillSelection = Selection;

export interface EffectiveLaunchConfig {
	/** Logical child id; the same value the child bridge reports back. */
	readonly subagentId: string;
	readonly invocation: PiInvocation;
	readonly cwd: string;
	readonly sessionId: string;
	/** Directory Pi uses for this child's session file; always passed explicitly so recovery can find the file. */
	readonly sessionDir: string;
	/** Known only once the session has been flushed to disk. */
	readonly sessionPath?: string;
	readonly agent: ResolvedAgentIdentity;
	readonly model: ResolvedModel;
	readonly thinking: ResolvedThinking;
	readonly tools: readonly string[];
	readonly excludeTools: readonly string[];
	readonly extensions: ExtensionSelection;
	readonly skills: SkillSelection;
	readonly prompt: string;
	readonly bridgeExtensionPath: string;
	/** Frozen at spawn. Interactive children do not auto-wake the parent except via contact_parent. */
	readonly interactive: boolean;
	/**
	 * Frozen result contract of a Task child. Its presence is what makes this launch a Task
	 * execution: the child can submit exactly one final result, and it is never resumed for
	 * more input afterwards.
	 */
	readonly task?: TaskChildContract;
}

export interface ResolvedAgentPolicy {
	readonly agent: ResolvedAgentIdentity;
	readonly model: ResolvedModel;
	readonly thinking: ResolvedThinking;
	readonly tools: readonly string[];
	readonly excludeTools: readonly string[];
	readonly extensions: ExtensionSelection;
	readonly skills: SkillSelection;
	readonly interactive: boolean;
}

export interface RuntimeMetadata {
	readonly runtimeIdentity: string;
	readonly endpoint: string;
	readonly pid?: number;
}

export type RuntimeClaimKind = "reconnect" | "replacement";

/** Non-secret, durable ownership claim used to serialize reconnect and replacement. */
export interface RuntimeClaim {
	readonly claimId: string;
	readonly kind: RuntimeClaimKind;
	readonly holderPid: number;
	readonly runtimeIdentity: string;
	readonly endpoint: string;
	/** SHA-256 of the one-time controller token; the token itself is never persisted. */
	readonly controllerTokenHash: string;
	/** Set by the runner before it starts the Pi writer. */
	readonly runnerPid?: number;
}

export interface UsageSummary {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly costUsd: number | null;
	readonly turns: number;
}

export interface SubagentRecord {
	readonly subagentId: string;
	readonly parentSessionId: string;
	readonly revision: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly sessionId: string;
	readonly sessionPath?: string;
	readonly cwd: string;
	readonly initialTask: string;
	readonly intent: SubagentIntent;
	readonly state: SubagentState;
	readonly mode: ExecutionMode;
	readonly persistence: PersistenceState;
	readonly launchConfig: EffectiveLaunchConfig;
	readonly runtime?: RuntimeMetadata;
	readonly claim?: RuntimeClaim;
	readonly latestSummary?: string;
	readonly usage?: UsageSummary;
	readonly interrupted?: string;
	readonly unacknowledgedInput?: string;
}

export interface PublicSubagent {
	readonly id: string;
	readonly agent: string;
	readonly displayName?: string;
	readonly state: SubagentState;
	readonly mode: ExecutionMode;
	readonly cwd: string;
	readonly sessionId: string;
	readonly summary?: string;
	readonly usage?: UsageSummary;
	readonly interrupted?: string;
	readonly freshness: "live" | "last_known";
	readonly interactive: boolean;
	readonly model: ResolvedModel;
	readonly thinking: ResolvedThinking;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface OperationError {
	readonly operation: string;
	readonly childId?: string;
	readonly reason: string;
	readonly sideEffects: readonly string[];
	readonly state?: SubagentState;
	readonly safeToRetry: boolean;
}

export interface SpawnSubagentInput {
	readonly task: string;
	readonly agent: string;
	readonly cwd?: string;
	/**
	 * Present when this child executes a Task rather than a conversation turn. It is frozen at
	 * acceptance and travels to the child as its result contract.
	 */
	readonly taskContract?: TaskChildContract;
}

/** True when a manager call returned a structured failure instead of a value. */
export function isOperationError(value: unknown): value is OperationError {
	return (
		isRecord(value) &&
		typeof value.operation === "string" &&
		typeof value.reason === "string" &&
		Array.isArray(value.sideEffects)
	);
}

/** The result contract of a Task child: an optional JSON Schema plus a soft reminder threshold. */
export interface TaskChildContract {
	/** JSON Schema the final result must validate against; absent means a text result is enough. */
	readonly schema?: unknown;
	/** Turn count after which the child is reminded once to converge. Never a hard stop. */
	readonly softTurns: number;
}

/** Child bridge tool name; agent tool policy must never remove it. */
export const CONTACT_PARENT_TOOL_NAME = "contact_parent" as const;

/** Environment contract between a parent launch and the child branch of this extension. */
export const BRIDGE_ENVIRONMENT_KEYS = {
	parentSessionId: "PI_SUBAGENTS_PARENT_SESSION_ID",
	childId: "PI_SUBAGENTS_CHILD_ID",
	runtimeId: "PI_SUBAGENTS_RUNTIME_ID",
	endpoint: "PI_SUBAGENTS_ENDPOINT",
	token: "PI_SUBAGENTS_TOKEN",
} as const;

/** Non-secret agent label for the child TUI identity line. Not part of handshake. */
export const CHILD_AGENT_ENV_KEY = "PI_SUBAGENTS_AGENT" as const;

/** Bound Pi session id for the child branch. Not part of the runner handshake. */
export const CHILD_SESSION_ENV_KEY = "PI_SUBAGENTS_SESSION_ID" as const;

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Pi session ids reach argv and file names, so they must stay in Pi's accepted alphabet. */
export function isSessionId(value: unknown): value is string {
	return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

const THINKING_LEVELS: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS[value] === true;
}

const SUBAGENT_STATES: Record<string, true> = {
	starting: true,
	running: true,
	idle: true,
	done: true,
	stopped: true,
	failed: true,
};

export function isSubagentState(value: unknown): value is SubagentState {
	return typeof value === "string" && SUBAGENT_STATES[value] === true;
}

const EXECUTION_MODES: Record<string, true> = { rpc: true, tui: true };

export function isExecutionMode(value: unknown): value is ExecutionMode {
	return typeof value === "string" && EXECUTION_MODES[value] === true;
}

const SUBAGENT_INTENTS: Record<string, true> = { active: true, stopped: true };

export function isSubagentIntent(value: unknown): value is SubagentIntent {
	return typeof value === "string" && SUBAGENT_INTENTS[value] === true;
}

const PERSISTENCE_STATES: Record<string, true> = { never_flushed: true, flushed: true };

export function isPersistenceState(value: unknown): value is PersistenceState {
	return typeof value === "string" && PERSISTENCE_STATES[value] === true;
}

const LAUNCH_VALUE_SOURCES: Record<string, true> = { agent: true, parent: true };

export function isLaunchValueSource(value: unknown): value is LaunchValueSource {
	return typeof value === "string" && LAUNCH_VALUE_SOURCES[value] === true;
}
