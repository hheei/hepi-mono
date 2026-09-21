import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChildIdentity, PROTOCOL_VERSION } from "../../src/domain.js";
import { attachJsonLineReader, writeJsonLine } from "../../src/json-lines.js";
import { type RunnerExit, type SubagentRunner, startRunner } from "../../src/runner.js";

export const FAKE_PI_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../fixtures/fake-pi.mjs",
);

export interface FakeRunner {
	readonly runner: SubagentRunner;
	readonly identity: ChildIdentity;
	readonly child: ChildProcessWithoutNullStreams;
	readonly diagnostics: string[];
	readonly directory: string;
	readonly closed: Promise<RunnerExit>;
	dispose(): Promise<void>;
}

export function spawnFakePi(env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
	return spawn(process.execPath, [FAKE_PI_PATH], {
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

export async function createIdentity(name: string, directory: string): Promise<ChildIdentity> {
	return {
		parentSessionId: `parent-${name}`,
		subagentId: `child-${name}`,
		runtimeIdentity: `runtime-${name}`,
		endpoint: join(directory, "runner.sock"),
		token: `token-${name}`,
	};
}

export async function createTempDirectory(prefix = "pi-subagents-runner-"): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDirectory(directory: string): Promise<void> {
	await rm(directory, { recursive: true, force: true });
}

/**
 * Starts a real runner over the fake Pi child, mirroring what runner-entry does
 * with a resolved launch spec.
 */
export async function startFakeRunner(
	options: {
		readonly name?: string;
		readonly piEnv?: Record<string, string>;
		readonly runnerOptions?: Partial<Parameters<typeof startRunner>[0]>;
	} = {},
): Promise<FakeRunner> {
	const directory = await createTempDirectory();
	const identity = await createIdentity(options.name ?? "one", directory);
	const spawnWriter = (): ReturnType<typeof spawnFakePi> => spawnFakePi(options.piEnv);
	const child = spawnWriter();
	const diagnostics: string[] = [];
	const runner = await startRunner({
		identity,
		process: child,
		spawnWriter,
		readyTimeoutMs: 5_000,
		requestTimeoutMs: 2_000,
		handshakeTimeoutMs: 1_000,
		shutdownGraceMs: 500,
		killGraceMs: 500,
		onDiagnostic: (line) => {
			diagnostics.push(line);
		},
		...options.runnerOptions,
	});
	const closed = runner.closed();
	return {
		runner,
		identity,
		child,
		diagnostics,
		directory,
		closed,
		dispose: async (): Promise<void> => {
			await runner.shutdown(new Error("test teardown"));
			await removeDirectory(directory);
		},
	};
}

export interface RawController {
	readonly socket: Socket;
	readonly frames: unknown[];
	send(frame: unknown): void;
	nextFrame(timeoutMs?: number): Promise<unknown>;
	closed(): Promise<void>;
	destroy(): void;
}

/** A hand-written controller socket, used to drive protocol violations. */
export async function openRawController(endpoint: string, hello: unknown): Promise<RawController> {
	const socket = createConnection(endpoint);
	const frames: unknown[] = [];
	const waiters: Array<(value: unknown) => void> = [];
	let closedResolve: (() => void) | undefined;
	const closedPromise = new Promise<void>((resolve) => {
		closedResolve = resolve;
	});
	attachJsonLineReader(socket, {
		maxFrameBytes: 1024 * 1024,
		onValue: (value) => {
			const waiter = waiters.shift();
			if (waiter !== undefined) waiter(value);
			else frames.push(value);
		},
		onError: () => undefined,
	});
	socket.on("close", () => closedResolve?.());
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
	await writeJsonLine(socket, hello, 1024 * 1024);
	return {
		socket,
		frames,
		send: (frame: unknown): void => {
			// Writing to a revoked socket is expected in these tests.
			void writeJsonLine(socket, frame, 1024 * 1024).catch(() => undefined);
		},
		nextFrame: (timeoutMs = 2_000): Promise<unknown> => {
			const queued = frames.shift();
			if (queued !== undefined) return Promise.resolve(queued);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const index = waiters.indexOf(onValue);
					if (index >= 0) waiters.splice(index, 1);
					reject(new Error("timed out waiting for a runner frame"));
				}, timeoutMs);
				const onValue = (value: unknown): void => {
					clearTimeout(timer);
					resolve(value);
				};
				waiters.push(onValue);
			});
		},
		closed: (): Promise<void> => closedPromise,
		destroy: (): void => {
			socket.destroy();
		},
	};
}

export function helloFrame(
	identity: ChildIdentity,
	overrides: Record<string, unknown> = {},
): unknown {
	return { version: PROTOCOL_VERSION, type: "hello", ...identity, ...overrides };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition was not met before the deadline");
}
