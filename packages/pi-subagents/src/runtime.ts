import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectWithRetry, RunnerConnection } from "./connector.js";
import type { ChildIdentity, SubagentRecord } from "./domain.js";
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
	const { record, registry } = options;
	const runtimeIdentity = randomUUID();
	const token = randomBytes(32).toString("hex");
	const directory = runtimeDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const endpoint = join(directory, `${record.subagentId}-${runtimeIdentity.slice(0, 12)}.sock`);
	const identity: ChildIdentity = {
		parentSessionId: record.parentSessionId,
		subagentId: record.subagentId,
		runtimeIdentity,
		endpoint,
		token,
	};
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
	const current = await registry.get(record.subagentId, options.signal);
	if (current === undefined)
		throw new Error(`Child ${record.subagentId} disappeared before launch`);
	await registry.update(
		record.subagentId,
		current.revision,
		(value) => ({
			...value,
			runtime: { runtimeIdentity, endpoint },
		}),
		undefined,
		options.signal,
	);

	const jobPath = join(directory, `${record.subagentId}-${runtimeIdentity}.json`);
	const job = {
		invocation: { command: launch.command, args: launch.argv },
		cwd: launch.cwd,
		sessionId: record.sessionId,
		...(record.sessionPath === undefined ? {} : { sessionPath: record.sessionPath }),
		env: launch.env,
	};
	await writeFile(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600, flag: "wx" });
	const runnerEntry = fileURLToPath(new URL("./runner-entry.js", import.meta.url));
	const child = spawn(process.execPath, [runnerEntry, "--job", jobPath], {
		cwd: launch.cwd,
		detached: true,
		env: { ...process.env, ...withBridgeToken(launch.env, token) },
		stdio: "ignore",
	});
	child.unref();
	const connection = new RunnerConnection({ endpoint, identity, token });
	try {
		await connectWithRetry(connection, {
			attempts: 120,
			delayMs: 50,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
		await unlink(jobPath).catch(() => undefined);
		return connection;
	} catch (error) {
		connection.close();
		child.kill("SIGTERM");
		await unlink(jobPath).catch(() => undefined);
		throw error;
	}
}
