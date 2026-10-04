/**
 * Runtime plumbing for a child Pi process that this parent owns.
 *
 * There is no supervisor: a background child is a child process of this Pi, and a child that runs in
 * a host panel is owned by that host. Either way the parent's bridge socket is what the child dials,
 * so "is this child alive?" is answered by a bridge connection, and the runtime metadata in the
 * registry only records which runtime and endpoint a child was last launched with.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@hheei/pi-ext-core";
import { type ChildRuntime, spawnChildRuntime } from "./child-process.js";
import type { Presentation, SubagentRecord } from "./domain.js";
import type { HostAdapter, HostAttachment } from "./host-adapter.js";
import { buildLaunchSpec, type LaunchSpec, withBridgeToken } from "./launch-spec.js";
import type { SubagentRegistry } from "./registry.js";

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
export function parentBridgeEndpoint(parentSessionId: string): string {
	return join(runtimeDirectory(), `parent-${parentSessionId}.sock`);
}

/**
 * Every parent session keeps its own token file. One shared file is rewritten wholesale by whichever
 * parent saved last, so two parent sessions in the same runtime directory would erase each other's
 * credentials and a child that survived a restart could no longer authorize itself.
 */
export function parentTokenFile(parentSessionId: string): string {
	return join(runtimeDirectory(), `tokens-${parentSessionId}.json`);
}

/**
 * Tokens outlive the parent process: a child that survived (a panel child, or one whose parent was
 * killed) reconnects with the token it was launched with, and a restarted parent must be able to
 * authorize it without holding the old process's memory. The store is a 0600 file in the 0700
 * runtime directory; the registry never sees a token.
 */
export function createRuntimeTokenStore(options: RuntimeTokenStoreOptions): RuntimeTokenStore {
	const file = options.file ?? parentTokenFile(options.parentSessionId);
	const diagnose = options.diagnose ?? ((): void => {});
	const tokens = new Map<string, string>(readStoredTokens(file, diagnose));
	let writing: Promise<void> = Promise.resolve();
	const persist = (): void => {
		const payload = `${JSON.stringify(Object.fromEntries(tokens))}\n`;
		writing = writing
			.then(async () => {
				mkdirSync(runtimeDirectory(), { recursive: true, mode: 0o700 });
				// Writing in place truncates the file first, and a parent killed inside that window would
				// leave every surviving child locked out of the bridge. The swap is atomic instead.
				const temporary = `${file}.${process.pid}.tmp`;
				await writeFile(temporary, payload, { mode: 0o600 });
				await rename(temporary, file);
			})
			.catch((error: unknown) => {
				diagnose(`could not persist bridge tokens: ${errorMessage(error)}`);
			});
	};
	return {
		remember(runtimeIdentity, token) {
			tokens.set(runtimeIdentity, token);
			persist();
		},
		get(runtimeIdentity) {
			return tokens.get(runtimeIdentity);
		},
		forget(runtimeIdentity) {
			if (tokens.delete(runtimeIdentity)) persist();
		},
	};
}

function readStoredTokens(
	file: string,
	diagnose: (message: string) => void,
): Array<[string, string]> {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code !== "ENOENT") diagnose(`could not read bridge tokens: ${errorMessage(error)}`);
		return [];
	}
	if (raw.trim() === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		diagnose(`bridge token file is not valid JSON: ${errorMessage(error)}`);
		return [];
	}
	if (typeof parsed !== "object" || parsed === null) return [];
	return Object.entries(parsed).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
}

export interface LaunchChildOptions {
	readonly registry: Pick<SubagentRegistry, "update">;
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
	if (connected) return { handle: runtime };
	await runtime.terminate();
	if (runtime.alive) {
		// The process outlived termination, so it is not gone and the caller keeps the handle: it is
		// the only thing that can try again.
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
 * What a launch left behind. A launch that failed can still have started something — a child that
 * never dialed in, or a process that ignores SIGTERM — and then the caller must keep the handle:
 * dropping it would let the next send start a second runtime for a session the first one may still
 * own. `failure` is what the caller reports.
 */
export interface LaunchOutcome<T> {
	readonly handle?: T;
	readonly failure?: string;
	/**
	 * Set when something may still own the child's session and this process cannot observe it, so
	 * the caller refuses to start a second runtime until an explicit stop.
	 */
	readonly unconfirmed?: boolean;
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
			unconfirmed: true,
			failure: `Child ${record.subagentId} could not be opened in a ${options.host.kind} panel (${errorMessage(error)}); a panel may have been created, so stop the child before sending again`,
		};
	}
	let connected: boolean;
	try {
		connected = await options.waitForBridge(record.subagentId, options.signal);
	} catch (error) {
		options.diagnose?.(`bridge wait failed: ${errorMessage(error)}`);
		connected = false;
	}
	if (connected) return { handle: attachment };
	// The child never dialed in, so the panel is closed again — and only a host that confirms it is
	// gone counts. While it may still run, the caller keeps the handle and the token: the handle is
	// what stops a second runtime from being started for the same session, and the token is what lets
	// a child that does come up be adopted instead of lingering as a process nobody owns.
	const cleanup = await attachment.cleanup();
	const observed = await attachment.observe();
	if (!(observed.known && !observed.alive)) {
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
