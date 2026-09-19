import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectWithRetry, RunnerConnection } from "./connector.js";
import type { ChildIdentity, RuntimeClaim, SubagentRecord } from "./domain.js";
import { buildLaunchSpec, withBridgeToken } from "./launch-spec.js";
import type { RunnerLike } from "./manager.js";
import type { SubagentRegistry } from "./registry.js";

export interface LaunchDetachedRunnerOptions {
	readonly registry: SubagentRegistry;
	readonly record: SubagentRecord;
	readonly signal?: AbortSignal;
}

function runtimeDirectory(): string {
	const user = typeof process.getuid === "function" ? process.getuid() : "user";
	return join(tmpdir(), `pi-subagents-${user}`);
}

/** Starts the package runner as a detached process and returns its authenticated controller. */
export async function launchDetachedRunner(
	options: LaunchDetachedRunnerOptions,
): Promise<RunnerLike> {
	const record = await requireCurrentRecord(
		options.registry,
		options.record.subagentId,
		options.signal,
	);
	const prepared = await claimRuntime(
		options.registry,
		record,
		"replacement",
		undefined,
		undefined,
		options.signal,
	);
	return startClaimedRunner(
		options.registry,
		prepared.record,
		prepared.identity,
		prepared.token,
		prepared.claim.claimId,
		options.signal,
	);
}

/** Reconnects to a surviving writer, launching a replacement only after its PID is confirmed dead. */
export async function recoverDetachedRunner(
	options: LaunchDetachedRunnerOptions,
): Promise<RunnerLike> {
	let record = await requireCurrentRecord(
		options.registry,
		options.record.subagentId,
		options.signal,
	);
	if (record.intent === "stopped") throw new Error(`Child ${record.subagentId} is stopped`);
	record = await clearDeadHolderClaim(options.registry, record, options.signal);

	if (record.runtime !== undefined) {
		const prepared = await claimRuntime(
			options.registry,
			record,
			"reconnect",
			record.runtime.runtimeIdentity,
			record.claim?.claimId,
			options.signal,
		);
		const connection = new RunnerConnection({
			endpoint: prepared.identity.endpoint,
			identity: prepared.identity,
			token: prepared.token,
			role: "recovery",
			claimId: prepared.claim.claimId,
		});
		try {
			await connectWithRetry(connection, {
				attempts: 20,
				delayMs: 50,
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
			return connection;
		} catch (error) {
			connection.close();
			const afterFailure = await requireCurrentRecord(
				options.registry,
				record.subagentId,
				options.signal,
			);
			if (afterFailure.claim?.claimId !== prepared.claim.claimId) {
				throw new Error(
					`Recovery authorization for ${record.subagentId} was consumed before the connection completed`,
					{ cause: error },
				);
			}
			if (!(await isRecordedRunnerConfirmedDead(afterFailure))) {
				await options.registry.releaseClaim(
					record.subagentId,
					prepared.claim.claimId,
					options.signal,
				);
				throw new Error(
					`Runner ${record.subagentId} could not be reconnected and is not confirmed dead; replacement refused`,
					{ cause: error },
				);
			}
			record = afterFailure;
		}
	}

	const expectedRuntimeIdentity = record.runtime?.runtimeIdentity;
	const prepared = await claimRuntime(
		options.registry,
		record,
		"replacement",
		expectedRuntimeIdentity,
		record.claim?.claimId,
		options.signal,
	);
	return startClaimedRunner(
		options.registry,
		prepared.record,
		prepared.identity,
		prepared.token,
		prepared.claim.claimId,
		options.signal,
	);
}

interface PreparedRuntime {
	readonly record: SubagentRecord;
	readonly identity: ChildIdentity;
	readonly token: string;
	readonly claim: RuntimeClaim;
}

async function claimRuntime(
	registry: SubagentRegistry,
	record: SubagentRecord,
	kind: RuntimeClaim["kind"],
	expectedRuntimeIdentity: string | undefined,
	expectedClaimId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<PreparedRuntime> {
	const runtimeIdentity = kind === "reconnect" ? expectedRuntimeIdentity : randomUUID();
	if (runtimeIdentity === undefined) throw new Error("Reconnect requires a runtime identity");
	const token = randomBytes(32).toString("hex");
	const directory = runtimeDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const endpoint =
		kind === "reconnect" && record.runtime !== undefined
			? record.runtime.endpoint
			: join(directory, `${record.subagentId}-${runtimeIdentity.slice(0, 12)}.sock`);
	const claim: RuntimeClaim = {
		claimId: randomUUID(),
		kind,
		holderPid: process.pid,
		runtimeIdentity,
		endpoint,
		controllerTokenHash: createHash("sha256").update(token).digest("hex"),
	};
	const claimed = await registry.claim(
		record.subagentId,
		record.revision,
		claim,
		expectedRuntimeIdentity,
		expectedClaimId,
		signal,
	);
	return {
		record: claimed,
		identity: {
			parentSessionId: claimed.parentSessionId,
			subagentId: claimed.subagentId,
			runtimeIdentity,
			endpoint,
			token,
		},
		token,
		claim,
	};
}

async function startClaimedRunner(
	registry: SubagentRegistry,
	record: SubagentRecord,
	identity: ChildIdentity,
	token: string,
	claimId: string,
	signal: AbortSignal | undefined,
): Promise<RunnerLike> {
	const launch = buildLaunchSpec({
		config: record.launchConfig,
		invocation: record.launchConfig.invocation,
		mode: "rpc",
		persistence: record.persistence,
		bridge: {
			parentSessionId: identity.parentSessionId,
			subagentId: identity.subagentId,
			runtimeIdentity: identity.runtimeIdentity,
			endpoint: identity.endpoint,
		},
	});
	const directory = runtimeDirectory();
	const jobPath = join(directory, `${record.subagentId}-${identity.runtimeIdentity}.json`);
	const job = {
		invocation: { command: launch.command, args: launch.argv },
		cwd: launch.cwd,
		sessionId: record.sessionId,
		...(record.sessionPath === undefined ? {} : { sessionPath: record.sessionPath }),
		claimId,
		env: launch.env,
	};
	let child: ChildProcess | undefined;
	const connection = new RunnerConnection({ endpoint: identity.endpoint, identity, token });
	try {
		await writeFile(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600, flag: "wx" });
		const runnerEntry = fileURLToPath(new URL("./runner-entry.js", import.meta.url));
		child = spawn(process.execPath, [runnerEntry, "--job", jobPath], {
			cwd: launch.cwd,
			detached: true,
			env: { ...process.env, ...withBridgeToken(launch.env, token) },
			stdio: "ignore",
		});
		if (child.pid === undefined)
			throw new Error(`Runner process for ${record.subagentId} has no PID`);
		await registry.markClaimRunner(record.subagentId, claimId, child.pid, signal);
		child.unref();
		await connectWithRetry(connection, {
			attempts: 120,
			delayMs: 50,
			...(signal === undefined ? {} : { signal }),
		});
		await unlink(jobPath).catch(() => undefined);
		return connection;
	} catch (error) {
		connection.close();
		child?.kill("SIGTERM");
		await unlink(jobPath).catch(() => undefined);
		const current = await registry.get(record.subagentId).catch(() => undefined);
		if (current?.claim?.claimId === claimId) {
			await registry.releaseClaim(record.subagentId, claimId).catch(() => undefined);
		}
		throw error;
	}
}

async function requireCurrentRecord(
	registry: SubagentRegistry,
	id: string,
	signal: AbortSignal | undefined,
): Promise<SubagentRecord> {
	const record = await registry.get(id, signal);
	if (record === undefined) throw new Error(`Child ${id} disappeared from the registry`);
	return record;
}

async function clearDeadHolderClaim(
	registry: SubagentRegistry,
	record: SubagentRecord,
	signal: AbortSignal | undefined,
): Promise<SubagentRecord> {
	const claim = record.claim;
	if (claim === undefined) return record;
	if (!isPidConfirmedDead(claim.holderPid)) {
		throw new Error(`Child ${record.subagentId} is already claimed by a live or unknown owner`);
	}
	if (claim.runnerPid !== undefined && !isPidConfirmedDead(claim.runnerPid)) {
		throw new Error(`Child ${record.subagentId} has a live or unknown claimed runner`);
	}
	return registry.releaseClaim(record.subagentId, claim.claimId, signal);
}
async function isRecordedRunnerConfirmedDead(record: SubagentRecord): Promise<boolean> {
	const runtime = record.runtime;
	if (runtime?.pid === undefined) return false;
	if (process.platform !== "linux") return isPidConfirmedDead(runtime.pid);
	try {
		const environment = await readFile(`/proc/${runtime.pid}/environ`, "utf8");
		const values = new Map(
			environment
				.split("\0")
				.filter(Boolean)
				.map((entry) => {
					const separator = entry.indexOf("=");
					return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
				}),
		);
		return values.get("PI_SUBAGENTS_RUNTIME_ID") !== runtime.runtimeIdentity
			? false
			: isPidConfirmedDead(runtime.pid);
	} catch (error) {
		return isErrno(error, "ENOENT");
	}
}

function isPidConfirmedDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return isErrno(error, "ESRCH");
	}
}

function isErrno(value: unknown, code: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		(value as NodeJS.ErrnoException).code === code
	);
}
