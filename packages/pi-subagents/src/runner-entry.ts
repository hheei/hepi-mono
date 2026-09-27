#!/usr/bin/env node
/**
 * Executable entry for one independently living pi-subagents runner.
 *
 * Usage:
 *   node runner-entry.js --job <job.json>      # or: node runner-entry.js <job.json>
 *   node runner-entry.js -                     # job JSON on stdin
 *
 * The job file carries the pre-resolved Pi `--mode rpc` invocation (command and
 * complete argv), cwd, session identity and extra environment variables. This
 * process never guesses the Pi CLI: it spawns exactly what the launch-spec
 * builder resolved in the parent.
 *
 * Identity comes from the `PI_SUBAGENTS_*` environment contract, which is also
 * inherited by the Pi child so its child branch can identify itself and reach
 * this runner's endpoint.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { errorMessage } from "@hheei/pi-ext-core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { writeDiagnostic } from "./diagnostics.js";
import type { ChildIdentity } from "./domain.js";
import { createSubagentRegistry } from "./registry.js";
import { startRunner } from "./runner.js";

export const RUNNER_JOB_FLAG = "--job";
export const JOB_FROM_STDIN = "-";

/** Bytes of Pi child stderr kept for failure diagnostics. */
export const STDERR_TAIL_BYTES = 16 * 1024;

export const RunnerJobSchema = Type.Object(
	{
		invocation: Type.Object(
			{ command: Type.String({ minLength: 1 }), args: Type.Array(Type.String()) },
			{ additionalProperties: false },
		),
		cwd: Type.String({ minLength: 1 }),
		sessionId: Type.String({ minLength: 1 }),
		sessionPath: Type.Optional(Type.String({ minLength: 1 })),
		claimId: Type.Optional(Type.String({ minLength: 1 })),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
	},
	{ additionalProperties: false },
);

export type RunnerJob = Static<typeof RunnerJobSchema>;

const IDENTITY_ENV_KEYS = {
	parentSessionId: "PI_SUBAGENTS_PARENT_SESSION_ID",
	subagentId: "PI_SUBAGENTS_CHILD_ID",
	runtimeIdentity: "PI_SUBAGENTS_RUNTIME_ID",
	endpoint: "PI_SUBAGENTS_ENDPOINT",
	token: "PI_SUBAGENTS_TOKEN",
} as const;

/** Reads the runner identity from the shared environment contract. */
export function readIdentityFromEnv(env: NodeJS.ProcessEnv): ChildIdentity {
	const read = (key: string): string => {
		const value = env[key];
		if (value === undefined || value === "") {
			throw new Error(`runner requires ${key} in its environment`);
		}
		return value;
	};
	return {
		parentSessionId: read(IDENTITY_ENV_KEYS.parentSessionId),
		subagentId: read(IDENTITY_ENV_KEYS.subagentId),
		runtimeIdentity: read(IDENTITY_ENV_KEYS.runtimeIdentity),
		endpoint: read(IDENTITY_ENV_KEYS.endpoint),
		token: read(IDENTITY_ENV_KEYS.token),
	};
}

/** Resolves the job source: `--job <path>`, a positional path, or stdin. */
export function resolveJobSource(argv: readonly string[]): string {
	const flagIndex = argv.indexOf(RUNNER_JOB_FLAG);
	if (flagIndex >= 0) {
		const value = argv[flagIndex + 1];
		if (value === undefined || value === "") throw new Error(`${RUNNER_JOB_FLAG} requires a path`);
		return value;
	}
	const positional = argv.find((argument) => !argument.startsWith("--"));
	if (positional === undefined) {
		throw new Error(`runner requires a job: ${RUNNER_JOB_FLAG} <path> or ${JOB_FROM_STDIN}`);
	}
	return positional;
}

export async function readRunnerJob(
	source: string,
	stdin: AsyncIterable<Buffer | string> = process.stdin,
): Promise<RunnerJob> {
	const raw = source === JOB_FROM_STDIN ? await readStream(stdin) : await readFile(source, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		throw new Error(`runner job is not valid JSON: ${errorMessage(error)}`);
	}
	if (!Value.Check(RunnerJobSchema, parsed))
		throw new Error("runner job does not match the runner job schema");
	return parsed;
}

async function readStream(stdin: AsyncIterable<Buffer | string>): Promise<string> {
	const chunks: string[] = [];
	for await (const chunk of stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
	}
	return chunks.join("");
}

async function main(): Promise<void> {
	const job = await readRunnerJob(resolveJobSource(process.argv.slice(2)));
	const identity = readIdentityFromEnv(process.env);
	const cwd = await stat(job.cwd).catch(() => undefined);
	if (cwd === undefined || !cwd.isDirectory()) {
		throw new Error(`runner job cwd is not a directory: ${job.cwd}`);
	}
	const registry = createSubagentRegistry({ parentSessionId: identity.parentSessionId });
	if (job.claimId !== undefined) {
		await registry.activateClaim(identity.subagentId, job.claimId, process.pid);
	}
	let stderrTail = "";
	const spawnWriter = (): ChildProcessWithoutNullStreams => {
		const next = spawn(job.invocation.command, [...job.invocation.args], {
			cwd: job.cwd,
			env: {
				...process.env,
				...(job.env ?? {}),
				[IDENTITY_ENV_KEYS.parentSessionId]: identity.parentSessionId,
				[IDENTITY_ENV_KEYS.subagentId]: identity.subagentId,
				[IDENTITY_ENV_KEYS.runtimeIdentity]: identity.runtimeIdentity,
				[IDENTITY_ENV_KEYS.endpoint]: identity.endpoint,
				[IDENTITY_ENV_KEYS.token]: identity.token,
			},
			stdio: ["pipe", "pipe", "pipe"] as const,
		});
		next.stderr.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_BYTES);
		});
		return next;
	};
	const child = spawnWriter();
	try {
		const runner = await startRunner({
			identity,
			process: child,
			spawnWriter,
			sessionId: job.sessionId,
			authorizeRecovery: async (claimId, token) => {
				const tokenHash = createHash("sha256").update(token).digest("hex");
				await registry.consumeReconnectClaim(
					identity.subagentId,
					claimId,
					tokenHash,
					identity.runtimeIdentity,
				);
				return true;
			},
			onDiagnostic: (line) => writeDiagnostic("runner", line),
		});
		writeDiagnostic(
			"runner",
			`ready endpoint=${identity.endpoint} child=${identity.subagentId} session=${job.sessionId}`,
		);
		const stop = (signal: string): void => {
			void runner.shutdown(new Error(`runner received ${signal}`));
		};
		process.once("SIGTERM", () => stop("SIGTERM"));
		process.once("SIGINT", () => stop("SIGINT"));
		const exit = await runner.closed();
		if (stderrTail !== "" && !exit.requested) {
			writeDiagnostic("runner", `Pi child stderr tail:\n${stderrTail}`);
		}
		// An explicit shutdown is a clean end; a child that died on its own is not.
		process.exitCode = exit.requested ? 0 : (exit.code ?? (exit.signal === null ? 0 : 1));
	} catch (error) {
		if (stderrTail !== "") writeDiagnostic("runner", `Pi child stderr tail:\n${stderrTail}`);
		throw error;
	}
}

void main().catch((error: unknown) => {
	writeDiagnostic("runner-entry", errorMessage(error));
	process.exitCode = 1;
});
