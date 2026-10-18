/**
 * Runtime plumbing for a child Pi process that this parent owns.
 *
 * There is no supervisor: a background child is a child process of this Pi, and a child that runs in
 * a host panel is owned by that host. Either way the parent's bridge socket is what the child dials,
 * so "is this child alive?" is answered by a bridge connection, and the runtime metadata in the
 * registry only records which runtime and endpoint a child was last launched with.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@hheei/pi-ext-core";
import { type ChildRuntime, spawnChildRuntime } from "./child-process.js";
import type { Presentation, SubagentRecord } from "./domain.js";
import type { HostAdapter, HostAttachment } from "./host-adapter.js";
import { buildLaunchSpec, type LaunchSpec, withBridgeToken } from "./launch-spec.js";
import { commitLease } from "./lease.js";
import type { SubagentRegistry } from "./registry.js";
import { defaultStatePath, deleteToken, openStateDb, readToken, writeToken } from "./state-db.js";

/** Per-runtime bridge tokens, kept out of the registry because they are credentials. */
export interface RuntimeTokenStore {
	remember(runtimeIdentity: string, token: string): void;
	get(runtimeIdentity: string): string | undefined;
	forget(runtimeIdentity: string): void;
}

export interface RuntimeTokenStoreOptions {
	/** The parent session these tokens belong to. */
	readonly parentSessionId: string;
	/** Override for tests. Defaults to this parent's file in the shared runtime directory. */
	readonly file?: string;
	readonly diagnose?: (message: string) => void;
}

function runtimeDirectory(): string {
	const user = typeof process.getuid === "function" ? process.getuid() : "user";
	return join(tmpdir(), `pi-subagents-${user}`);
}

/**
 * The one socket a parent session listens on. A child dials this path, so a parent that restarts
 * re-listens in the same place and a surviving child reconnects instead of being rebuilt.
 */
export function parentBridgeEndpoint(_parentSessionId: string): string {
	return defaultStatePath();
}

/** Tokens live in the same sqlite file as the child ledger. Rows do not clobber each other. */
export function parentTokenFile(_parentSessionId: string): string {
	return defaultStatePath();
}

/**
 * Tokens outlive the parent process. A restarted parent reads the same sqlite file and can still
 * match the token a surviving child was launched with.
 */
export function createRuntimeTokenStore(options: RuntimeTokenStoreOptions): RuntimeTokenStore {
	const file = options.file ?? defaultStatePath();
	const diagnose = options.diagnose ?? ((): void => {});
	let db: ReturnType<typeof openStateDb> | undefined;
	try {
		db = openStateDb(file);
	} catch (error) {
		diagnose(`could not open the state database: ${errorMessage(error)}`);
	}
	const database = db;
	return {
		remember(runtimeIdentity, token) {
			if (database === undefined) return;
			writeToken(database, options.parentSessionId, runtimeIdentity, token);
		},
		get(runtimeIdentity) {
			if (database === undefined) return undefined;
			return readToken(database, options.parentSessionId, runtimeIdentity);
		},
		forget(runtimeIdentity) {
			if (database === undefined) return;
			deleteToken(database, options.parentSessionId, runtimeIdentity);
		},
	};
}

export interface LaunchChildOptions {
	readonly registry: Pick<SubagentRegistry, "get" | "update">;
	readonly record: SubagentRecord;
	readonly tokens: RuntimeTokenStore;
	/** Waits for this child's bridge connection; false when it did not connect in time. */
	readonly waitForBridge: (childId: string, signal?: AbortSignal) => Promise<boolean>;
	readonly signal?: AbortSignal;
	readonly diagnose?: (message: string) => void;
}

interface ChildRuntimePlan {
	readonly runtimeIdentity: string;
	readonly endpoint: string;
	readonly spec: LaunchSpec;
}

/**
 * Mints the runtime identity and its bridge token, remembers the token so the child's very first
 * hello can be authorized, and builds the one LaunchSpec for this presentation. The token travels
 * in the spec's environment, because who starts the child differs: the parent starts a background
 * child and the host starts a panel one.
 */
function planChildRuntime(
	record: SubagentRecord,
	tokens: RuntimeTokenStore,
	presentation: Presentation,
): ChildRuntimePlan {
	const runtimeIdentity = randomUUID();
	const token = randomBytes(32).toString("hex");
	const endpoint = parentBridgeEndpoint(record.parentSessionId);
	const spec = buildLaunchSpec({
		config: record.launchConfig,
		invocation: record.launchConfig.invocation,
		presentation,
		persistence: record.persistence,
		bridge: {
			parentSessionId: record.parentSessionId,
			subagentId: record.subagentId,
			runtimeIdentity,
			endpoint,
		},
	});
	tokens.remember(runtimeIdentity, token);
	return { runtimeIdentity, endpoint, spec: { ...spec, env: withBridgeToken(spec.env, token) } };
}

/** Evidence first: the record names the runtime that was asked for even if starting it fails. */
async function recordRuntimeEvidence(
	registry: Pick<SubagentRegistry, "update">,
	record: SubagentRecord,
	plan: ChildRuntimePlan,
): Promise<void> {
	await registry.update(record.subagentId, undefined, (current) => ({
		...current,
		runtime: { runtimeIdentity: plan.runtimeIdentity, endpoint: plan.endpoint },
	}));
}

/**
 * Starts one headless child Pi and waits for it to connect. Nothing is driven over its stdio: the
 * process gets the parent's socket path and its own runtime token in the environment, and the
 * bridge is the only control channel. A child that never connects is terminated here rather than
 * left running with no way to reach it.
 */
export async function launchChild(
	options: LaunchChildOptions,
): Promise<LaunchOutcome<ChildRuntime>> {
	const record = options.record;
	const plan = planChildRuntime(record, options.tokens, "background");
	await recordRuntimeEvidence(options.registry, record, plan);
	const runtime = spawnChildRuntime({
		command: plan.spec.command,
		args: plan.spec.argv,
		cwd: plan.spec.cwd,
		env: { ...process.env, ...plan.spec.env },
		...(options.diagnose === undefined ? {} : { diagnose: options.diagnose }),
	});
	let connected: boolean;
	try {
		connected = await options.waitForBridge(record.subagentId, options.signal);
	} catch (error) {
		options.diagnose?.(`bridge wait failed: ${errorMessage(error)}`);
		connected = false;
	}
	if (connected) {
		await bindProcess(options.registry, record.subagentId, runtime.pid);
		return { handle: runtime };
	}
	await runtime.terminate();
	if (runtime.alive) {
		// The process outlived termination, so it is not gone and the caller keeps the handle: it is
		// the only thing that can try again.
		await bindProcess(options.registry, record.subagentId, runtime.pid);
		return {
			handle: runtime,
			failure: `Child ${record.subagentId} never connected to the parent bridge and did not stop (it may still be running)`,
		};
	}
	options.tokens.forget(plan.runtimeIdentity);
	await options.registry.update(
		record.subagentId,
		undefined,
		(current) => {
			const { runtime: _runtime, ...rest } = current;
			return rest;
		},
		plan.runtimeIdentity,
	);
	return { failure: `Child ${record.subagentId} never connected to the parent bridge` };
}

export interface OpenChildPanelOptions extends LaunchChildOptions {
	readonly host: HostAdapter;
}

/**
 * What a launch left behind. `failure` is what the caller reports. A handle is kept when the host
 * still has a tab, so stop can close it. It does not by itself forbid another send.
 */
export interface LaunchOutcome<T> {
	readonly handle?: T;
	readonly failure?: string;
}

/**
 * Opens one child in a host panel and waits for it to connect. The host owns this process, so the
 * parent holds no runtime handle for it; a panel that never yields a bridge is closed again instead
 * of being left as a process nobody can control.
 */
export async function openChildPanel(
	options: OpenChildPanelOptions,
): Promise<LaunchOutcome<HostAttachment>> {
	const record = options.record;
	const plan = planChildRuntime(record, options.tokens, "panel");
	await recordRuntimeEvidence(options.registry, record, plan);
	let attachment: HostAttachment;
	try {
		attachment = await options.host.open(plan.spec);
	} catch (error) {
		// Opening is not atomic: the host may have created the panel and started the process before
		// failing to report it. The token is kept so a child that does come up can still be adopted,
		// and the caller is told the runtime is unconfirmed instead of that nothing was started.
		return {
			failure: `Child ${record.subagentId} could not be opened in a ${options.host.kind} panel (${errorMessage(error)}); a panel may have been created, so close it if it is still there`,
		};
	}
	let connected: boolean;
	try {
		connected = await options.waitForBridge(record.subagentId, options.signal);
	} catch (error) {
		options.diagnose?.(`bridge wait failed: ${errorMessage(error)}`);
		connected = false;
	}
	if (connected) {
		await bindPanel(
			options.registry,
			record.subagentId,
			options.host.kind,
			attachment.identity.attachmentId,
		);
		return { handle: attachment };
	}
	// The child never dialed in, so the panel is closed again. A host that cannot confirm it is gone
	// keeps the handle, so stop can try the close again, and the token, so a child that does come up
	// can still be adopted. The handle does not block a later send.
	const cleanup = await attachment.cleanup();
	const observed = await attachment.observe();
	if (!(observed.known && !observed.alive)) {
		await bindPanel(
			options.registry,
			record.subagentId,
			options.host.kind,
			attachment.identity.attachmentId,
		);
		return {
			handle: attachment,
			failure: `Child ${record.subagentId} never connected to the parent bridge and its panel could not be closed (${
				cleanup.stderr || "its state could not be observed"
			}); close it manually`,
		};
	}
	options.tokens.forget(plan.runtimeIdentity);
	await options.registry.update(
		record.subagentId,
		undefined,
		(current) => {
			const { runtime: _runtime, ...rest } = current;
			return rest;
		},
		plan.runtimeIdentity,
	);
	return { failure: `Child ${record.subagentId} never connected to the parent bridge` };
}

/** Creates the runtime directory if needed; the socket itself is 0600 in a 0700 directory. */
export async function prepareRuntimeDirectory(
	diagnose?: (message: string) => void,
): Promise<string> {
	const directory = runtimeDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700).catch((error: unknown) => {
		diagnose?.(`could not restrict the runtime directory: ${errorMessage(error)}`);
	});
	return directory;
}

async function bindProcess(
	registry: Pick<SubagentRegistry, "get" | "update">,
	id: string,
	pid: number | undefined,
): Promise<void> {
	if (pid === undefined) return;
	await commitLease(registry, id, {
		type: "attachment-bound",
		attachment: { kind: "process", pid },
	});
}

async function bindPanel(
	registry: Pick<SubagentRegistry, "get" | "update">,
	id: string,
	host: "herdr" | "cmux",
	attachmentId: string,
): Promise<void> {
	await commitLease(registry, id, {
		type: "attachment-bound",
		attachment: { kind: "panel", host, id: attachmentId },
	});
}
