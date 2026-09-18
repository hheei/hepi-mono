import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { RunnerConnectionOptions } from "../src/connector.js";
import { connectWithRetry, RunnerConnection } from "../src/connector.js";
import { PROTOCOL_VERSION } from "../src/domain.js";
import { attachJsonLineReader, writeJsonLine } from "../src/json-lines.js";
import {
	createTempDirectory,
	removeDirectory,
	startFakeRunner,
	waitFor,
} from "./helpers/runner-harness.js";

type Harness = Awaited<ReturnType<typeof startFakeRunner>>;

const servers: Server[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
});

function connectionFor(
	harness: Harness,
	overrides: Partial<RunnerConnectionOptions> = {},
): RunnerConnection {
	return new RunnerConnection({
		endpoint: harness.identity.endpoint,
		identity: harness.identity,
		token: harness.identity.token,
		connectTimeoutMs: 2_000,
		requestTimeoutMs: 2_000,
		...overrides,
	});
}

describe("runner connection", () => {
	test("connects through the identity handshake and forwards requests", async () => {
		const harness = await startFakeRunner();
		const connection = connectionFor(harness);
		try {
			expect(connection.connected).toBe(false);
			await connection.connect();
			expect(connection.connected).toBe(true);
			await expect(connection.request("get_state")).resolves.toMatchObject({
				sessionId: "fake-session",
			});
			// Re-connecting is a no-op while the socket is healthy.
			await expect(connection.connect()).resolves.toBeUndefined();
		} finally {
			connection.close();
			expect(connection.connected).toBe(false);
			await harness.dispose();
		}
	});

	test("reconnects from the same instance after close", async () => {
		const harness = await startFakeRunner();
		const connection = connectionFor(harness);
		try {
			await connection.connect();
			await connection.request("get_state");
			connection.close();
			expect(connection.connected).toBe(false);
			await expect(connection.request("get_state")).rejects.toThrow(/not connected/);

			await connection.connect();
			await expect(connection.request("get_state")).resolves.toMatchObject({
				sessionId: "fake-session",
			});
			// Closing the connector never kills the Pi child the runner owns.
			expect(harness.child.exitCode).toBeNull();
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("leaves the runner alive for the next parent after close", async () => {
		const harness = await startFakeRunner();
		const first = connectionFor(harness);
		try {
			await first.connect();
			await first.request("prompt", { message: "hello" });
			first.close();

			const second = connectionFor(harness);
			await second.connect();
			await expect(second.request("get_state")).resolves.toMatchObject({
				sessionId: "fake-session",
			});
			second.close();
		} finally {
			await harness.dispose();
		}
	});

	test("fails in-flight requests when the runner disappears", async () => {
		const harness = await startFakeRunner({ piEnv: { FAKE_PI_IGNORE: "prompt" } });
		const connection = connectionFor(harness, { requestTimeoutMs: 30_000 });
		try {
			await connection.connect();
			const pending = connection.request("prompt", { message: "hold" });
			const rejection = pending.catch((error: unknown) => (error as Error).message);
			// Give the request a chance to be in flight before the runner dies.
			await waitFor(() => connection.connected);
			await new Promise((resolve) => setTimeout(resolve, 50));
			await harness.runner.shutdown(new Error("stop the runtime"));
			await expect(rejection).resolves.toMatch(/disconnected|closed/i);
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("rejects the connection when the runner refuses the handshake", async () => {
		const harness = await startFakeRunner();
		const connection = connectionFor(harness, { token: "wrong-token" });
		try {
			await expect(connection.connect()).rejects.toThrow(/disconnected|handshake|timed out/i);
			expect(connection.connected).toBe(false);
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("ignores a response that arrives after the request timed out", async () => {
		const harness = await startFakeRunner({
			piEnv: { FAKE_PI_SLOW: "get_state", FAKE_PI_SLOW_MS: "150" },
		});
		const connection = connectionFor(harness, { requestTimeoutMs: 50 });
		try {
			await connection.connect();
			await expect(connection.request("get_state")).rejects.toThrow(/timed out/);
			// The late response must not kill the connection.
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(connection.connected).toBe(true);
			await expect(
				connection.request("get_state", undefined, { timeoutMs: 2_000 }),
			).resolves.toMatchObject({ sessionId: "fake-session" });
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("bounds pending requests", async () => {
		const harness = await startFakeRunner({ piEnv: { FAKE_PI_IGNORE: "prompt" } });
		const connection = connectionFor(harness, { maxPendingRequests: 1, requestTimeoutMs: 5_000 });
		try {
			await connection.connect();
			const first = connection.request("prompt", { message: "one" });
			await expect(connection.request("prompt", { message: "two" })).rejects.toThrow(
				/pending request limit/,
			);
			connection.close();
			await expect(first).rejects.toThrow(/closed/);
		} finally {
			await harness.dispose();
		}
	});

	test("fails closed on a malformed server frame", async () => {
		const directory = await createTempDirectory("pi-subagents-fake-server-");
		const endpoint = join(directory, "fake-server.sock");
		const server = createServer((socket) => {
			attachJsonLineReader(socket, {
				maxFrameBytes: 1024,
				onValue: () => undefined,
				onError: () => undefined,
			});
			// Answer the request first, then send a frame the protocol rejects.
			const frames = [
				{ version: PROTOCOL_VERSION, type: "hello_ack" },
				{ version: PROTOCOL_VERSION, type: "nonsense" },
			];
			void (async () => {
				for (const frame of frames) {
					await writeJsonLine(socket, frame, 1024);
					await new Promise((resolve) => setTimeout(resolve, 30));
				}
			})().catch(() => undefined);
		});
		servers.push(server);
		await new Promise<void>((resolve) => {
			server.listen(endpoint, () => resolve());
		});
		const connection = new RunnerConnection({
			endpoint,
			identity: {
				parentSessionId: "p",
				subagentId: "c",
				runtimeIdentity: "r",
				endpoint,
				token: "t",
			},
			token: "t",
			connectTimeoutMs: 2_000,
			requestTimeoutMs: 2_000,
		});
		try {
			await connection.connect();
			const rejection = connection.request("get_state", undefined, { timeoutMs: 3_000 }).then(
				() => "resolved",
				(error: Error) => error.message,
			);
			await waitFor(() => !connection.connected, 2_000);
			expect(await rejection).toMatch(/malformed frame/);
		} finally {
			connection.close();
			await removeDirectory(directory);
		}
	});

	test("connectWithRetry stops on abort instead of retrying", async () => {
		const harness = await startFakeRunner();
		const connection = connectionFor(harness);
		try {
			await harness.runner.shutdown(new Error("dead runtime"));
			const abort = new AbortController();
			const retrying = connectWithRetry(connection, {
				attempts: 50,
				delayMs: 20,
				signal: abort.signal,
			});
			abort.abort();
			await expect(retrying).rejects.toThrow(/aborted/i);
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("stops delivering events once the listener is detached", async () => {
		const harness = await startFakeRunner({ piEnv: { FAKE_PI_NOISY: "1" } });
		const connection = connectionFor(harness);
		const events: unknown[] = [];
		try {
			await connection.connect();
			const detach = connection.onEvent((event) => events.push(event));
			await connection.request("prompt", { message: "hello" });
			await waitFor(() => events.length >= 2);
			detach();
			const seen = events.length;
			await connection.request("abort");
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(events.length).toBe(seen);
		} finally {
			connection.close();
			await harness.dispose();
		}
	});
});
