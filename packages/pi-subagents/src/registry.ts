import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord, readJsonSettingsRoot, updateJsonSettingsRoot } from "@hheei/pi-ext-core";
import type {
	EffectiveLaunchConfig,
	PiInvocation,
	ResolvedAgentIdentity,
	ResolvedModel,
	ResolvedThinking,
	RuntimeMetadata,
	Selection,
	SubagentRecord,
	UsageSummary,
} from "./domain.js";
import {
	isLaunchValueSource,
	isPersistenceState,
	isPresentation,
	isSessionId,
	isSubagentIntent,
	isSubagentState,
	isThinkingLevel,
	normalizeSubagentState,
	REGISTRY_VERSION,
} from "./domain.js";

export type RegistryErrorCode =
	| "invalid_parent_session"
	| "corrupt_registry"
	| "unsupported_version"
	| "parent_mismatch"
	| "invalid_record"
	| "duplicate_child"
	| "unknown_child"
	| "stale_revision"
	| "runtime_mismatch"
	| "stopped_child";

export class SubagentRegistryError extends Error {
	readonly code: RegistryErrorCode;

	public constructor(code: RegistryErrorCode, message: string) {
		super(message);
		this.name = "SubagentRegistryError";
		this.code = code;
	}
}

/**
 * Per-parent-session JSON registry. It holds only durable facts needed to find and
 * resume a child: identity, session placement, intent, the non-secret launch
 * snapshot, and reconnect metadata. Liveness is never inferred from this file, and
 * no secrets are stored.
 */
export interface SubagentRegistry {
	readonly path: string;
	readonly parentSessionId: string;
	get(id: string, signal?: AbortSignal): Promise<SubagentRecord | undefined>;
	list(signal?: AbortSignal): Promise<readonly SubagentRecord[]>;
	create(record: SubagentRecord, signal?: AbortSignal): Promise<SubagentRecord>;
	/**
	 * Conditional write. `expectedRevision` guards against stale writers, and
	 * `expectedRuntimeIdentity` additionally refuses updates whose target runtime has
	 * already been replaced by a newer one. The registry owns `revision` and
	 * `updatedAt`; the updater's values for those fields are ignored.
	 */
	update(
		id: string,
		expectedRevision: number | undefined,
		updater: (record: SubagentRecord) => SubagentRecord,
		expectedRuntimeIdentity?: string,
		signal?: AbortSignal,
	): Promise<SubagentRecord>;
}

export interface CreateSubagentRegistryOptions {
	readonly parentSessionId: string;
	/** Override for tests and for callers that keep the registry outside the agent dir. */
	readonly filePath?: string;
	readonly now?: () => Date;
}

export function defaultRegistryPath(parentSessionId: string): string {
	return join(getAgentDir(), "pi-subagents", "registry", `${parentSessionId}.json`);
}

const ROOT_FIELDS: Record<string, true> = {
	version: true,
	parentSessionId: true,
	updatedAt: true,
	records: true,
};

const RECORD_FIELDS: Record<string, true> = {
	subagentId: true,
	parentSessionId: true,
	revision: true,
	createdAt: true,
	updatedAt: true,
	sessionId: true,
	sessionPath: true,
	cwd: true,
	initialTask: true,
	intent: true,
	state: true,
	presentation: true,
	persistence: true,
	launchConfig: true,
	runtime: true,
	latestSummary: true,
	activeTool: true,
	usage: true,
	interrupted: true,
	unacknowledgedInput: true,
};

const LAUNCH_CONFIG_FIELDS: Record<string, true> = {
	subagentId: true,
	invocation: true,
	cwd: true,
	sessionId: true,
	sessionDir: true,
	sessionPath: true,
	agent: true,
	model: true,
	thinking: true,
	tools: true,
	excludeTools: true,
	extensions: true,
	skills: true,
	prompt: true,
	bridgeExtensionPath: true,
	title: true,
	task: true,
	codemodeOnly: true,
};

const AGENT_FIELDS: Record<string, true> = {
	name: true,
	displayName: true,
	description: true,
	hidden: true,
	sourcePath: true,
	instructions: true,
};

const INVOCATION_FIELDS: Record<string, true> = { command: true, args: true };
const MODEL_FIELDS: Record<string, true> = { provider: true, id: true, source: true };
const THINKING_FIELDS: Record<string, true> = { level: true, source: true };
const SELECTION_FIELDS: Record<string, true> = { discovery: true, paths: true };
const RUNTIME_FIELDS: Record<string, true> = { runtimeIdentity: true, endpoint: true };

const USAGE_FIELDS: Record<string, true> = {
	inputTokens: true,
	outputTokens: true,
	cacheReadTokens: true,
	cacheWriteTokens: true,
	costUsd: true,
	turns: true,
};

function corrupt(path: string, message: string): SubagentRegistryError {
	return new SubagentRegistryError("corrupt_registry", `Invalid registry ${path}: ${message}`);
}

function invalid(path: string, message: string): SubagentRegistryError {
	return new SubagentRegistryError(
		"invalid_record",
		`Invalid subagent record in ${path}: ${message}`,
	);
}

function expectKeys(
	value: Record<string, unknown>,
	allowed: Record<string, true>,
	label: string,
	path: string,
): void {
	for (const key of Object.keys(value)) {
		if (allowed[key] !== true) throw invalid(path, `${label} has unsupported field ${key}`);
	}
}

function expectString(value: unknown, label: string, path: string): string {
	if (typeof value !== "string" || value === "") {
		throw invalid(path, `${label} must be a non-empty string`);
	}
	return value;
}

function expectOptionalString(value: unknown, label: string, path: string): string | undefined {
	if (value === undefined) return undefined;
	return expectString(value, label, path);
}

function expectOptionalBoolean(
	value: unknown,
	label: string,
	path: string,
	fallback: boolean,
): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw invalid(path, `${label} must be boolean`);
	return value;
}

function expectIsoDate(value: unknown, label: string, path: string): string {
	const text = expectString(value, label, path);
	if (Number.isNaN(Date.parse(text))) throw invalid(path, `${label} must be an ISO timestamp`);
	return text;
}

function expectNonNegativeNumber(value: unknown, label: string, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw invalid(path, `${label} must be a finite non-negative number`);
	}
	return value;
}

function expectObject(value: unknown, label: string, path: string): Record<string, unknown> {
	if (!isRecord(value)) throw invalid(path, `${label} must be an object`);
	return value;
}

function expectStringArray(value: unknown, label: string, path: string): string[] {
	if (!Array.isArray(value)) throw invalid(path, `${label} must be an array`);
	return value.map((item) => expectString(item, label, path));
}

function parseInvocation(value: unknown, path: string): PiInvocation {
	const raw = expectObject(value, "launchConfig.invocation", path);
	expectKeys(raw, INVOCATION_FIELDS, "launchConfig.invocation", path);
	return Object.freeze({
		command: expectString(raw.command, "launchConfig.invocation.command", path),
		args: Object.freeze(expectStringArray(raw.args, "launchConfig.invocation.args", path)),
	});
}

function parseAgent(value: unknown, path: string): ResolvedAgentIdentity {
	const raw = expectObject(value, "launchConfig.agent", path);
	expectKeys(raw, AGENT_FIELDS, "launchConfig.agent", path);
	if (typeof raw.hidden !== "boolean")
		throw invalid(path, "launchConfig.agent.hidden must be boolean");
	const displayName = expectOptionalString(raw.displayName, "launchConfig.agent.displayName", path);
	const description = expectOptionalString(raw.description, "launchConfig.agent.description", path);
	return Object.freeze({
		name: expectString(raw.name, "launchConfig.agent.name", path),
		...(displayName === undefined ? {} : { displayName }),
		...(description === undefined ? {} : { description }),
		hidden: raw.hidden,
		sourcePath: expectString(raw.sourcePath, "launchConfig.agent.sourcePath", path),
		instructions: expectString(raw.instructions, "launchConfig.agent.instructions", path),
	});
}

function parseModel(value: unknown, path: string): ResolvedModel {
	const raw = expectObject(value, "launchConfig.model", path);
	expectKeys(raw, MODEL_FIELDS, "launchConfig.model", path);
	const source = raw.source;
	if (!isLaunchValueSource(source)) throw invalid(path, "launchConfig.model.source is invalid");
	return Object.freeze({
		provider: expectString(raw.provider, "launchConfig.model.provider", path),
		id: expectString(raw.id, "launchConfig.model.id", path),
		source,
	});
}

function parseThinking(value: unknown, path: string): ResolvedThinking {
	const raw = expectObject(value, "launchConfig.thinking", path);
	expectKeys(raw, THINKING_FIELDS, "launchConfig.thinking", path);
	const level = raw.level;
	if (!isThinkingLevel(level)) throw invalid(path, "launchConfig.thinking.level is invalid");
	const source = raw.source;
	if (!isLaunchValueSource(source)) throw invalid(path, "launchConfig.thinking.source is invalid");
	return Object.freeze({ level, source });
}

function parseSelection(value: unknown, path: string, field: "extensions" | "skills"): Selection {
	const raw = expectObject(value, `launchConfig.${field}`, path);
	expectKeys(raw, SELECTION_FIELDS, `launchConfig.${field}`, path);
	if (typeof raw.discovery !== "boolean") {
		throw invalid(path, `launchConfig.${field}.discovery must be boolean`);
	}
	return Object.freeze({
		discovery: raw.discovery,
		paths: Object.freeze(expectStringArray(raw.paths, `launchConfig.${field}.paths`, path)),
	});
}

function parseUsage(value: unknown, path: string): UsageSummary {
	const raw = expectObject(value, "usage", path);
	expectKeys(raw, USAGE_FIELDS, "usage", path);
	const costUsd = raw.costUsd;
	if (
		costUsd !== null &&
		(typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0)
	) {
		throw invalid(path, "usage.costUsd must be null or a finite non-negative number");
	}
	const turns = expectNonNegativeNumber(raw.turns, "usage.turns", path);
	if (!Number.isInteger(turns)) throw invalid(path, "usage.turns must be an integer");
	return Object.freeze({
		inputTokens: expectNonNegativeNumber(raw.inputTokens, "usage.inputTokens", path),
		outputTokens: expectNonNegativeNumber(raw.outputTokens, "usage.outputTokens", path),
		cacheReadTokens: expectNonNegativeNumber(raw.cacheReadTokens, "usage.cacheReadTokens", path),
		cacheWriteTokens: expectNonNegativeNumber(raw.cacheWriteTokens, "usage.cacheWriteTokens", path),
		costUsd,
		turns,
	});
}

function parseRuntime(value: unknown, path: string): RuntimeMetadata {
	const raw = expectObject(value, "runtime", path);
	expectKeys(raw, RUNTIME_FIELDS, "runtime", path);
	const runtimeIdentity = expectString(raw.runtimeIdentity, "runtime.runtimeIdentity", path);
	const endpoint = expectString(raw.endpoint, "runtime.endpoint", path);
	return Object.freeze({ runtimeIdentity, endpoint });
}

function parseLaunchConfig(value: unknown, path: string): EffectiveLaunchConfig {
	const raw = expectObject(value, "launchConfig", path);
	expectKeys(raw, LAUNCH_CONFIG_FIELDS, "launchConfig", path);
	const sessionId = expectString(raw.sessionId, "launchConfig.sessionId", path);
	if (!isSessionId(sessionId))
		throw invalid(path, "launchConfig.sessionId is not a valid session id");
	const sessionPath = expectOptionalString(raw.sessionPath, "launchConfig.sessionPath", path);
	const extensions = parseSelection(raw.extensions, path, "extensions");
	const bridgeExtensionPath = expectString(
		raw.bridgeExtensionPath,
		"launchConfig.bridgeExtensionPath",
		path,
	);
	if (!extensions.paths.includes(bridgeExtensionPath)) {
		throw invalid(path, "launchConfig.bridgeExtensionPath is missing from the extension selection");
	}
	const subagentId = expectString(raw.subagentId, "launchConfig.subagentId", path);
	if (!isSessionId(subagentId))
		throw invalid(path, "launchConfig.subagentId is not a valid child id");
	const title = expectOptionalString(raw.title, "launchConfig.title", path);
	return Object.freeze({
		subagentId,
		invocation: parseInvocation(raw.invocation, path),
		cwd: expectString(raw.cwd, "launchConfig.cwd", path),
		sessionId,
		sessionDir: expectString(raw.sessionDir, "launchConfig.sessionDir", path),
		...(sessionPath === undefined ? {} : { sessionPath }),
		agent: parseAgent(raw.agent, path),
		model: parseModel(raw.model, path),
		thinking: parseThinking(raw.thinking, path),
		tools: Object.freeze(expectStringArray(raw.tools, "launchConfig.tools", path)),
		excludeTools: Object.freeze(
			expectStringArray(raw.excludeTools, "launchConfig.excludeTools", path),
		),
		extensions,
		skills: parseSelection(raw.skills, path, "skills"),
		prompt: expectString(raw.prompt, "launchConfig.prompt", path),
		bridgeExtensionPath,
		...(expectOptionalBoolean(raw.codemodeOnly, "launchConfig.codemodeOnly", path, false)
			? { codemodeOnly: true }
			: {}),
		...(title === undefined ? {} : { title }),
	});
}

/** Strictly revalidates one record read from disk; partial or unknown shapes never become state. */
export function parseSubagentRecord(
	value: unknown,
	key: string,
	parentSessionId: string,
	path: string,
): SubagentRecord {
	const raw = expectObject(value, `record ${key}`, path);
	if (raw.presentation === undefined && raw.mode !== undefined) {
		// A record from the attach era names its presentation `mode`, and that field means something
		// else now (who holds the child's process), so it is never guessed at: the user deletes the
		// record and this version starts the child fresh. Checked before the field list, because the
		// old field is otherwise just "unsupported".
		throw invalid(
			path,
			`record ${key} was written by an older version (mode ${JSON.stringify(raw.mode)}); delete this record to use presentation "panel" | "background"`,
		);
	}
	expectKeys(raw, RECORD_FIELDS, `record ${key}`, path);
	const subagentId = expectString(raw.subagentId, "subagentId", path);
	if (subagentId !== key) throw invalid(path, `record ${key} declares subagentId ${subagentId}`);
	if (!isSessionId(subagentId)) throw invalid(path, `record ${key} has an invalid subagentId`);
	if (raw.parentSessionId !== parentSessionId) {
		throw invalid(path, `record ${key} belongs to another parent session`);
	}
	const revision = expectNonNegativeNumber(raw.revision, "revision", path);
	if (!Number.isInteger(revision) || revision < 1) {
		throw invalid(path, `record ${key} revision must be a positive integer`);
	}
	const rawState = raw.state;
	if (!isSubagentState(rawState)) throw invalid(path, `record ${key} state is invalid`);
	const state = normalizeSubagentState(rawState) ?? (rawState as SubagentRecord["state"]);
	const presentation = raw.presentation;
	if (!isPresentation(presentation)) throw invalid(path, `record ${key} presentation is invalid`);
	const intent = raw.intent;
	if (!isSubagentIntent(intent)) throw invalid(path, `record ${key} intent is invalid`);
	const persistence = raw.persistence;
	if (!isPersistenceState(persistence)) throw invalid(path, `record ${key} persistence is invalid`);
	const sessionId = expectString(raw.sessionId, "sessionId", path);
	if (!isSessionId(sessionId))
		throw invalid(path, `record ${key} sessionId is not a valid session id`);
	const sessionPath = expectOptionalString(raw.sessionPath, "sessionPath", path);
	const launchConfig = parseLaunchConfig(raw.launchConfig, path);
	if (launchConfig.subagentId !== subagentId) {
		throw invalid(path, `record ${key} subagentId disagrees with its launch config`);
	}
	if (launchConfig.sessionId !== sessionId) {
		throw invalid(path, `record ${key} sessionId disagrees with its launch config`);
	}
	if (launchConfig.cwd !== expectString(raw.cwd, "cwd", path)) {
		throw invalid(path, `record ${key} cwd disagrees with its launch config`);
	}
	if (persistence === "flushed") {
		if (sessionPath === undefined || launchConfig.sessionPath !== sessionPath) {
			throw invalid(path, `record ${key} claims a flushed session without a matching path`);
		}
	} else if (sessionPath !== undefined || launchConfig.sessionPath !== undefined) {
		throw invalid(path, `record ${key} claims a never-flushed session with a session path`);
	}
	const runtime = raw.runtime === undefined ? undefined : parseRuntime(raw.runtime, path);
	const usage = raw.usage === undefined ? undefined : parseUsage(raw.usage, path);
	const latestSummary = expectOptionalString(raw.latestSummary, "latestSummary", path);
	const activeTool = expectOptionalString(raw.activeTool, "activeTool", path);
	const interrupted = expectOptionalString(raw.interrupted, "interrupted", path);
	const unacknowledgedInput = expectOptionalString(
		raw.unacknowledgedInput,
		"unacknowledgedInput",
		path,
	);

	return Object.freeze({
		subagentId,
		parentSessionId,
		revision,
		createdAt: expectIsoDate(raw.createdAt, "createdAt", path),
		updatedAt: expectIsoDate(raw.updatedAt, "updatedAt", path),
		sessionId,
		...(sessionPath === undefined ? {} : { sessionPath }),
		cwd: launchConfig.cwd,
		initialTask: expectString(raw.initialTask, "initialTask", path),
		intent,
		state,
		presentation,
		persistence,
		launchConfig,
		...(runtime === undefined ? {} : { runtime }),
		...(latestSummary === undefined ? {} : { latestSummary }),
		...(activeTool === undefined ? {} : { activeTool }),
		...(usage === undefined ? {} : { usage }),
		...(interrupted === undefined ? {} : { interrupted }),
		...(unacknowledgedInput === undefined ? {} : { unacknowledgedInput }),
	});
}

function parseRoot(
	raw: Record<string, unknown>,
	path: string,
	parentSessionId: string,
): Map<string, SubagentRecord> {
	if (Object.keys(raw).length === 0) return new Map();
	const version = raw.version;
	if (version === undefined) throw corrupt(path, "missing version");
	if (version !== REGISTRY_VERSION) {
		throw new SubagentRegistryError(
			"unsupported_version",
			`Unsupported registry version ${String(version)} in ${path}; expected ${REGISTRY_VERSION}`,
		);
	}
	if (raw.parentSessionId !== parentSessionId) {
		throw new SubagentRegistryError(
			"parent_mismatch",
			`Registry ${path} belongs to parent session ${String(raw.parentSessionId)}, not ${parentSessionId}`,
		);
	}
	const records = raw.records;
	if (!isRecord(records)) throw corrupt(path, "records must be an object");
	const parsed = new Map<string, SubagentRecord>();
	for (const [id, value] of Object.entries(records)) {
		parsed.set(id, parseSubagentRecord(value, id, parentSessionId, path));
	}
	return parsed;
}

function writeRoot(
	root: Record<string, unknown>,
	parentSessionId: string,
	records: Map<string, SubagentRecord>,
	now: Date,
): void {
	for (const key of Object.keys(root)) {
		if (ROOT_FIELDS[key] !== true) delete root[key];
	}
	root.version = REGISTRY_VERSION;
	root.parentSessionId = parentSessionId;
	root.updatedAt = now.toISOString();
	root.records = Object.fromEntries(records);
}

export function createSubagentRegistry(options: CreateSubagentRegistryOptions): SubagentRegistry {
	const { parentSessionId } = options;
	if (!isSessionId(parentSessionId)) {
		throw new SubagentRegistryError(
			"invalid_parent_session",
			`Invalid parent session id ${parentSessionId}`,
		);
	}
	const path = options.filePath ?? defaultRegistryPath(parentSessionId);
	const now = options.now ?? ((): Date => new Date());

	const readRecords = async (signal?: AbortSignal): Promise<Map<string, SubagentRecord>> =>
		parseRoot(await readJsonSettingsRoot(path, signal), path, parentSessionId);

	const store: SubagentRegistry = {
		path,
		parentSessionId,
		async get(id, signal) {
			return (await readRecords(signal)).get(id);
		},
		async list(signal) {
			const records = [...(await readRecords(signal)).values()];
			records.sort((left, right) =>
				left.createdAt === right.createdAt
					? left.subagentId.localeCompare(right.subagentId)
					: left.createdAt.localeCompare(right.createdAt),
			);
			return records;
		},
		async create(record, signal) {
			let stored: SubagentRecord | undefined;
			await updateJsonSettingsRoot(
				path,
				(root) => {
					const records = parseRoot(root, path, parentSessionId);
					const candidate = parseSubagentRecord(record, record.subagentId, parentSessionId, path);
					if (records.has(candidate.subagentId)) {
						throw new SubagentRegistryError(
							"duplicate_child",
							`Child ${candidate.subagentId} already exists in ${path}`,
						);
					}
					records.set(candidate.subagentId, candidate);
					writeRoot(root, parentSessionId, records, now());
					stored = candidate;
				},
				signal,
			);
			if (stored === undefined) throw corrupt(path, "create did not persist a record");
			return stored;
		},
		async update(id, expectedRevision, updater, expectedRuntimeIdentity, signal) {
			let stored: SubagentRecord | undefined;
			await updateJsonSettingsRoot(
				path,
				(root) => {
					const records = parseRoot(root, path, parentSessionId);
					const current = records.get(id);
					if (current === undefined) {
						throw new SubagentRegistryError("unknown_child", `Unknown child ${id} in ${path}`);
					}
					if (expectedRevision !== undefined && current.revision !== expectedRevision) {
						throw new SubagentRegistryError(
							"stale_revision",
							`Child ${id} is at revision ${current.revision}, not ${expectedRevision}`,
						);
					}
					if (
						expectedRuntimeIdentity !== undefined &&
						current.runtime?.runtimeIdentity !== expectedRuntimeIdentity
					) {
						throw new SubagentRegistryError(
							"runtime_mismatch",
							`Child ${id} runtime is ${current.runtime?.runtimeIdentity ?? "none"}, not ${expectedRuntimeIdentity}`,
						);
					}
					const next = parseSubagentRecord(
						{
							...updater(current),
							subagentId: current.subagentId,
							parentSessionId: current.parentSessionId,
							createdAt: current.createdAt,
							revision: current.revision + 1,
							updatedAt: now().toISOString(),
						},
						id,
						parentSessionId,
						path,
					);
					records.set(id, next);
					writeRoot(root, parentSessionId, records, now());
					stored = next;
				},
				signal,
			);
			if (stored === undefined) throw corrupt(path, `update of ${id} did not persist a record`);
			return stored;
		},
	};
	return store;
}
