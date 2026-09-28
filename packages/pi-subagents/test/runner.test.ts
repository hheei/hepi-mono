import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { isRecord } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import {
	connectWithRetry,
	RunnerConnection,
	sendLifecycleToRunner,
	sendReportToRunner,
	sendTaskResultToRunner,
} from "../src/connector.js";
import { type ChildIdentity, PROTOCOL_VERSION } from "../src/domain.js";
import { startRunner } from "../src/runner.js";
import {
	createIdentity,
	createTempDirectory,
	helloFrame,
	openRawController,
	removeDirectory,
	spawnFakePi,
	startFakeRunner,
	waitFor,
} from "./helpers/runner-harness.js";

function connectionFor(identity: ChildIdentity): RunnerConnection {
	return new RunnerConnection({
		endpoint: identity.endpoint,
		identity,
		token: identity.token,
		connectTimeoutMs: 2_000,
		requestTimeoutMs: 2_000,
	});
}

function runnerOptions(diagnostics: string[] = []): {
	readonly requestTimeoutMs: number;
	readonly readyTimeoutMs: number;
	readonly onDiagnostic: (line: string) => void;
} {
	return {
		requestTimeoutMs: 2_000,
		readyTimeoutMs: 5_000,
		onDiagnostic: (line: string) => diagnostics.push(line),
	};
}

describe("runner IPC", () => {
	test("accepts one authenticated controller and forwards Pi operations", async () => {
		const harness = await startFakeRunner();
		const connection = connectionFor(harness.identity);
		try {
			await connection.connect();
			await expect(connection.request("get_state")).resolves.toMatchObject({
				sessionId: "fake-session",
			});
			await expect(connection.request("prompt", { message: "hello" })).resolves.toBeUndefined();
			await expect(connection.request("get_entries")).resolves.toMatchObject({ leafId: "entry-1" });
			await expect(connection.request("get_session_stats")).resolves.toMatchObject({ turns: 1 });
			await expect(connection.request("abort")).resolves.toBeUndefined();
			expect(harness.child.exitCode).toBeNull();
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("forwards Pi RPC events to the connected controller", async () => {
		const harness = await startFakeRunner({ piEnv: { FAKE_PI_NOISY: "2" } });
		const connection = connectionFor(harness.identity);
		const events: unknown[] = [];
		connection.onEvent((event) => events.push(event));
		try {
			await connection.connect();
			await connection.request("prompt", { message: "hello" });
			await waitFor(() => events.length >= 3);
			expect(events).toEqual([
				{ type: "agent_start" },
				{ type: "message_update", index: 0 },
				{ type: "message_update", index: 1 },
			]);
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("rejects an unauthenticated handshake and keeps serving", async () => {
		const harness = await startFakeRunner();
		try {
			const badToken = await openRawController(
				harness.identity.endpoint,
				helloFrame(harness.identity, { token: "wrong-token" }),
			);
			await badToken.closed();
			expect(badToken.frames).toEqual([]);

			const foreignParent = await openRawController(
				harness.identity.endpoint,
				helloFrame(harness.identity, { parentSessionId: "other-parent" }),
			);
			await foreignParent.closed();

			const missingField = await openRawController(harness.identity.endpoint, {
				version: PROTOCOL_VERSION,
				type: "hello",
				parentSessionId: harness.identity.parentSessionId,
				subagentId: harness.identity.subagentId,
				runtimeIdentity: harness.identity.runtimeIdentity,
				endpoint: harness.identity.endpoint,
			});
			await missingField.closed();

			const valid = await openRawController(
				harness.identity.endpoint,
				helloFrame(harness.identity),
			);
			expect(await valid.nextFrame()).toEqual({ version: PROTOCOL_VERSION, type: "hello_ack" });
			valid.destroy();
		} finally {
			await harness.dispose();
		}
	});

	test("a new authenticated controller revokes the previous one", async () => {
		const harness = await startFakeRunner();
		const first = await openRawController(harness.identity.endpoint, helloFrame(harness.identity));
		try {
			expect(await first.nextFrame()).toEqual({ version: PROTOCOL_VERSION, type: "hello_ack" });
			const second = await openRawController(
				harness.identity.endpoint,
				helloFrame(harness.identity),
			);
			expect(await second.nextFrame()).toEqual({ version: PROTOCOL_VERSION, type: "hello_ack" });
			await first.closed();

			second.send({
				version: PROTOCOL_VERSION,
				type: "request",
				id: "req-1",
				operation: "get_state",
			});
			expect(await second.nextFrame()).toMatchObject({ type: "response", id: "req-1", ok: true });
			second.destroy();
		} finally {
			await harness.dispose();
		}
	});

	test("stale frames from a revoked controller cannot reach the new controller", async () => {
		const harness = await startFakeRunner({ piEnv: { FAKE_PI_IGNORE: "prompt" } });
		const first = await openRawController(harness.identity.endpoint, helloFrame(harness.identity));
		try {
			await first.nextFrame();
			first.send({
				version: PROTOCOL_VERSION,
				type: "request",
				id: "stale-1",
				operation: "prompt",
				payload: { message: "stale" },
			});
			const second = await openRawController(
				harness.identity.endpoint,
				helloFrame(harness.identity),
			);
			expect(await second.nextFrame()).toEqual({ version: PROTOCOL_VERSION, type: "hello_ack" });
			await first.closed();
			// Replaying the revoked controller's frame on its dead socket changes nothing.
			first.send({
				version: PROTOCOL_VERSION,
				type: "request",
				id: "stale-2",
				operation: "shutdown",
			});

			second.send({
				version: PROTOCOL_VERSION,
				type: "request",
				id: "fresh-1",
				operation: "get_state",
			});
			const response = (await second.nextFrame()) as { id?: string; ok?: boolean };
			expect(response.id).toBe("fresh-1");
			expect(response.ok).toBe(true);
			expect(harness.child.exitCode).toBeNull();
			second.destroy();
		} finally {
			await harness.dispose();
		}
	});

	test("answers duplicate request IDs with an explicit failure", async () => {
		const harness = await startFakeRunner({ piEnv: { FAKE_PI_IGNORE: "prompt" } });
		const controller = await openRawController(
			harness.identity.endpoint,
			helloFrame(harness.identity),
		);
		try {
			await controller.nextFrame();
			for (const message of ["first", "second"]) {
				controller.send({
					version: PROTOCOL_VERSION,
					type: "request",
					id: "dup",
					operation: "prompt",
					payload: { message },
				});
			}
			const response = (await controller.nextFrame()) as {
				ok?: boolean;
				error?: { code?: string };
			};
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("duplicate_request_id");
		} finally {
			controller.destroy();
			await harness.dispose();
		}
	});

	test("bounds pending requests per controller", async () => {
		const harness = await startFakeRunner({
			piEnv: { FAKE_PI_IGNORE: "prompt" },
			runnerOptions: { maxPendingRequests: 2 },
		});
		const controller = await openRawController(
			harness.identity.endpoint,
			helloFrame(harness.identity),
		);
		try {
			await controller.nextFrame();
			for (const id of ["a", "b", "c"]) {
				controller.send({
					version: PROTOCOL_VERSION,
					type: "request",
					id,
					operation: "prompt",
					payload: { message: "hold" },
				});
			}
			const response = (await controller.nextFrame()) as {
				id?: string;
				ok?: boolean;
				error?: { code?: string };
			};
			expect(response.ok).toBe(false);
			expect(response.error?.code).toBe("too_many_pending_requests");
		} finally {
			controller.destroy();
			await harness.dispose();
		}
	});

	test("closes only the misbehaving controller on a malformed frame", async () => {
		const harness = await startFakeRunner();
		const controller = await openRawController(
			harness.identity.endpoint,
			helloFrame(harness.identity),
		);
		try {
			await controller.nextFrame();
			controller.send({
				version: PROTOCOL_VERSION,
				type: "request",
				id: "x",
				operation: "not_an_operation",
			});
			await controller.closed();
			expect(harness.diagnostics.some((line) => line.includes("malformed frame"))).toBe(true);
			expect(harness.child.exitCode).toBeNull();

			const replacement = connectionFor(harness.identity);
			await replacement.connect();
			await expect(replacement.request("get_state")).resolves.toMatchObject({
				sessionId: "fake-session",
			});
			replacement.close();
		} finally {
			await harness.dispose();
		}
	});

	test("keeps the runner and Pi child alive when the controller disconnects", async () => {
		const harness = await startFakeRunner({
			piEnv: { FAKE_PI_NOISY: "2", FAKE_PI_EVENT_DELAY_MS: "30" },
		});
		const childPid = harness.child.pid;
		const first = connectionFor(harness.identity);
		try {
			await first.connect();
			await first.request("prompt", { message: "produce events" });
			first.close();
			await new Promise((resolve) => setTimeout(resolve, 150));

			const second = connectionFor(harness.identity);
			const events: unknown[] = [];
			second.onEvent((event) => events.push(event));
			await second.connect();
			await waitFor(() => events.length >= 3);
			expect(events).toEqual([
				{ type: "agent_start" },
				{ type: "message_update", index: 0 },
				{ type: "message_update", index: 1 },
			]);
			expect(harness.child.pid).toBe(childPid);
			expect(harness.child.exitCode).toBeNull();
			second.close();
		} finally {
			await harness.dispose();
		}
	});

	test("reports dropped buffered events on reconnect instead of hiding the gap", async () => {
		const harness = await startFakeRunner({
			piEnv: { FAKE_PI_NOISY: "6", FAKE_PI_EVENT_DELAY_MS: "30" },
			runnerOptions: { maxBufferedEvents: 2 },
		});
		const first = connectionFor(harness.identity);
		try {
			await first.connect();
			await first.request("prompt", { message: "burst" });
			first.close();
			await new Promise((resolve) => setTimeout(resolve, 150));

			const second = connectionFor(harness.identity);
			const events: unknown[] = [];
			second.onEvent((event) => events.push(event));
			await second.connect();
			await waitFor(() => events.length >= 3);
			expect(events[0]).toMatchObject({ type: "runner_events_dropped" });
			expect((events[0] as { count: number }).count).toBeGreaterThan(0);
			second.close();
		} finally {
			await harness.dispose();
		}
	});

	test("ends in-flight requests on timeout and abort", async () => {
		const harness = await startFakeRunner({
			piEnv: { FAKE_PI_IGNORE: "prompt" },
			runnerOptions: { requestTimeoutMs: 150 },
		});
		const connection = connectionFor(harness.identity);
		try {
			await connection.connect();
			await expect(connection.request("prompt", { message: "never answered" })).rejects.toThrow(
				/timed out/,
			);
			const abort = new AbortController();
			const pending = connection.request(
				"prompt",
				{ message: "cancelled" },
				{ signal: abort.signal },
			);
			abort.abort();
			await expect(pending).rejects.toThrow(/aborted/i);
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("rejects malformed payloads before they reach Pi", async () => {
		const harness = await startFakeRunner();
		const connection = connectionFor(harness.identity);
		try {
			await connection.connect();
			await expect(connection.request("prompt", { message: "" })).rejects.toThrow(
				/non-empty message/,
			);
			await expect(connection.request("get_state", { extra: true })).rejects.toThrow(
				/does not accept a payload/,
			);
			await expect(connection.request("get_entries", { since: 5 })).rejects.toThrow(
				/get_entries payload/,
			);
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("reports the Pi child exit and settles finitely", async () => {
		const harness = await startFakeRunner({
			piEnv: { FAKE_PI_EXIT_AFTER: "prompt", FAKE_PI_EXIT_CODE: "9", FAKE_PI_EVENT_DELAY_MS: "10" },
		});
		const connection = connectionFor(harness.identity);
		const events: unknown[] = [];
		connection.onEvent((event) => events.push(event));
		try {
			await connection.connect();
			await connection.request("prompt", { message: "crash" });
			const exit = await harness.closed;
			expect(exit.code).toBe(9);
			expect(exit.requested).toBe(false);
			await waitFor(() =>
				events.some((event) => (event as { type?: string }).type === "runner_exit"),
			);
			await expect(stat(harness.identity.endpoint)).rejects.toThrow(/ENOENT/);
		} finally {
			connection.close();
			await removeDirectory(harness.directory);
		}
	});

	test("explicit shutdown answers the controller and releases every resource", async () => {
		const harness = await startFakeRunner({ piEnv: { FAKE_PI_IGNORE_SIGTERM: "1" } });
		const connection = connectionFor(harness.identity);
		try {
			await connection.connect();
			await expect(connection.request("shutdown")).resolves.toBeUndefined();
			const exit = await harness.closed;
			expect(exit.requested).toBe(true);
			expect(exit.signal).toBe("SIGKILL");
			expect(harness.child.exitCode !== null || harness.child.signalCode !== null).toBe(true);
			await expect(stat(harness.identity.endpoint)).rejects.toThrow(/ENOENT/);
			expect(harness.diagnostics.some((line) => line.includes("SIGKILL"))).toBe(true);
			// Shutdown is idempotent and already complete.
			await expect(harness.runner.shutdown()).resolves.toBe(exit);
		} finally {
			connection.close();
			await removeDirectory(harness.directory);
		}
	});

	test("refuses to steal an endpoint owned by a live runner", async () => {
		const harness = await startFakeRunner();
		const secondChild = spawnFakePi();
		try {
			const identity = await createIdentity("second", harness.directory);
			await expect(
				startRunner({ identity, process: secondChild, ...runnerOptions() }),
			).rejects.toThrow(/already owns endpoint/);
			// The live runner's endpoint and controller access survive the attempt.
			const connection = connectionFor(harness.identity);
			await connection.connect();
			await expect(connection.request("get_state")).resolves.toMatchObject({
				sessionId: "fake-session",
			});
			connection.close();
		} finally {
			await harness.dispose();
		}
	});

	test("refuses to delete an endpoint path that is not a socket", async () => {
		const directory = await createTempDirectory();
		const identity = await createIdentity("nonsocket", directory);
		await writeFile(identity.endpoint, "not a socket");
		const child = spawnFakePi();
		try {
			await expect(startRunner({ identity, process: child, ...runnerOptions() })).rejects.toThrow(
				/not a Unix socket/,
			);
			await expect(stat(identity.endpoint)).resolves.toBeDefined();
		} finally {
			child.kill("SIGKILL");
			await removeDirectory(directory);
		}
	});

	test("removes a stale socket left behind by a killed runner", async () => {
		const directory = await createTempDirectory();
		const identity = await createIdentity("stale", directory);
		await leaveStaleSocket(identity.endpoint);
		expect((await stat(identity.endpoint)).isSocket()).toBe(true);

		const diagnostics: string[] = [];
		const child = spawnFakePi();
		const runner = await startRunner({ identity, process: child, ...runnerOptions(diagnostics) });
		try {
			expect(diagnostics.some((line) => line.includes("removed stale endpoint"))).toBe(true);
			const connection = connectionFor(identity);
			await connection.connect();
			await expect(connection.request("get_state")).resolves.toMatchObject({
				sessionId: "fake-session",
			});
			connection.close();
		} finally {
			await runner.shutdown(new Error("stale test"));
			await removeDirectory(directory);
		}
	});

	test("connectWithRetry fails finitely when no runner owns the endpoint", async () => {
		const directory = await createTempDirectory();
		const identity = await createIdentity("absent", directory);
		const connection = connectionFor(identity);
		try {
			const started = Date.now();
			await expect(connectWithRetry(connection, { attempts: 5, delayMs: 10 })).rejects.toThrow(
				/ENOENT|connect/i,
			);
			expect(Date.now() - started).toBeLessThan(2_000);
			expect(connection.connected).toBe(false);
		} finally {
			connection.close();
			await removeDirectory(directory);
		}
	});

	test("connectWithRetry waits for a runner that is still coming up", async () => {
		const harness = await startFakeRunner();
		try {
			await harness.runner.shutdown(new Error("simulate a dead runner"));
			const identity = await createIdentity("starting", harness.directory);
			const child = spawnFakePi();
			const connection = connectionFor(identity);
			const retrying = connectWithRetry(connection, { attempts: 60, delayMs: 25 });
			const runner = await startRunner({ identity, process: child, ...runnerOptions() });
			try {
				await expect(retrying).resolves.toBeUndefined();
				await expect(connection.request("get_state")).resolves.toMatchObject({
					sessionId: "fake-session",
				});
				connection.close();
			} finally {
				await runner.shutdown(new Error("retry test"));
			}
		} finally {
			await removeDirectory(harness.directory);
		}
	});
	test("acknowledges authenticated child reports without replacing the parent controller", async () => {
		const harness = await startFakeRunner();
		const connection = connectionFor(harness.identity);
		const events: unknown[] = [];
		connection.onEvent((event) => events.push(event));
		try {
			await connection.connect();
			await sendReportToRunner(harness.identity, {
				type: "pi_subagent_report",
				parentSessionId: harness.identity.parentSessionId,
				childId: harness.identity.subagentId,
				runtimeIdentity: harness.identity.runtimeIdentity,
				reason: "progress_update",
				message: "working",
			});
			await waitFor(() => events.length === 1);
			expect(events[0]).toMatchObject({
				type: "subagent_report",
				report: { message: "working" },
			});
			expect(connection.connected).toBe(true);
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("rejects contact_parent from a session that has left the bound child", async () => {
		const harness = await startFakeRunner();
		try {
			await sendLifecycleToRunner(harness.identity, {
				type: "child_lifecycle",
				parentSessionId: harness.identity.parentSessionId,
				childId: harness.identity.subagentId,
				runtimeIdentity: harness.identity.runtimeIdentity,
				kind: "left_session",
				sessionId: "session-b",
			});
			await expect(
				sendReportToRunner(harness.identity, {
					type: "pi_subagent_report",
					parentSessionId: harness.identity.parentSessionId,
					childId: harness.identity.subagentId,
					runtimeIdentity: harness.identity.runtimeIdentity,
					reason: "progress_update",
					message: "from B",
					sessionId: "session-b",
				}),
			).rejects.toThrow(/bridge_unbound/);
		} finally {
			await harness.dispose();
		}
	});

	test("accepts a repeated final result and refuses a different one", async () => {
		const harness = await startFakeRunner();
		try {
			const controller = await openRawController(
				harness.identity.endpoint,
				helloFrame(harness.identity),
			);
			try {
				const payload = {
					type: "task_result" as const,
					parentSessionId: harness.identity.parentSessionId,
					childId: harness.identity.subagentId,
					runtimeIdentity: harness.identity.runtimeIdentity,
					json: "done",
					structured: false,
				};
				await sendTaskResultToRunner(harness.identity, payload);
				// The controller sees the result once, after its own handshake frame.
				expect(await controller.nextFrame()).toMatchObject({ type: "hello_ack" });
				expect(await controller.nextFrame()).toMatchObject({
					type: "event",
					event: { type: "task_result", json: "done" },
				});

				// The child retries when a response is lost, and the parent holds this result already, so
				// the repeat must not look like a failure or arrive as a second result.
				await sendTaskResultToRunner(harness.identity, payload);
				await expect(
					sendTaskResultToRunner(harness.identity, { ...payload, json: "other" }),
				).rejects.toThrow(/result_already_submitted/u);
				expect(controller.frames).toEqual([]);
			} finally {
				controller.destroy();
			}
		} finally {
			await harness.dispose();
		}
	});

	test("hands a result to a reconnected controller when its socket cannot take it", async () => {
		// A negative budget makes every write look congested, which is the state a controller that
		// stopped reading leaves behind.
		const harness = await startFakeRunner({ runnerOptions: { maxControllerBufferBytes: -1 } });
		let second: Awaited<ReturnType<typeof openRawController>> | undefined;
		try {
			const first = await openRawController(
				harness.identity.endpoint,
				helloFrame(harness.identity),
			);
			await first.nextFrame();
			await sendTaskResultToRunner(harness.identity, {
				type: "task_result",
				parentSessionId: harness.identity.parentSessionId,
				childId: harness.identity.subagentId,
				runtimeIdentity: harness.identity.runtimeIdentity,
				json: "done",
				structured: false,
			});
			// The controller that cannot take the result is dropped instead of holding it.
			await expect(first.closed()).resolves.toBeUndefined();

			second = await openRawController(harness.identity.endpoint, helloFrame(harness.identity));
			expect(await second.nextFrame()).toMatchObject({ type: "hello_ack" });
			expect(await second.nextFrame()).toMatchObject({
				type: "event",
				event: { type: "task_result", json: "done" },
			});
		} finally {
			second?.destroy();
			await harness.dispose();
		}
	});

	test("rejects a report when the offline report queue is full", async () => {
		const harness = await startFakeRunner({ runnerOptions: { maxBufferedEvents: 1 } });
		try {
			const report = {
				type: "pi_subagent_report" as const,
				parentSessionId: harness.identity.parentSessionId,
				childId: harness.identity.subagentId,
				runtimeIdentity: harness.identity.runtimeIdentity,
				reason: "blocked" as const,
				message: "first",
			};
			await sendReportToRunner(harness.identity, report);
			await expect(
				sendReportToRunner(harness.identity, { ...report, message: "second" }),
			).rejects.toThrow(/report_queue_full/);
		} finally {
			await harness.dispose();
		}
	});

	test("keeps the runner socket while replacing the RPC writer", async () => {
		const harness = await startFakeRunner();
		const connection = connectionFor(harness.identity);
		try {
			await connection.connect();
			await expect(connection.request("get_state")).resolves.toMatchObject({
				sessionId: "fake-session",
			});
			await expect(connection.request("close_writer")).resolves.toEqual({ closed: true });
			await expect(connection.request("get_state")).rejects.toThrow(/RPC writer is not bound/);
			await expect(connection.request("start_rpc")).resolves.toMatchObject({
				sessionId: "fake-session",
			});
			await expect(connection.request("get_state")).resolves.toMatchObject({
				sessionId: "fake-session",
			});
			expect(harness.runner.endpoint).toBe(harness.identity.endpoint);
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("acks pause immediately when the child is idle", async () => {
		const harness = await startFakeRunner();
		const connection = connectionFor(harness.identity);
		try {
			await connection.connect();
			await expect(connection.request("pause")).resolves.toMatchObject({
				paused: true,
				idle: true,
			});
		} finally {
			connection.close();
			await harness.dispose();
		}
	});

	test("notifies the child bridge and waits for report_paused when busy", async () => {
		const harness = await startFakeRunner({
			piEnv: { FAKE_PI_BUSY: "1" },
			runnerOptions: { requestTimeoutMs: 2_000 },
		});
		const controller = connectionFor(harness.identity);
		const bridge = new RunnerConnection({
			endpoint: harness.identity.endpoint,
			identity: harness.identity,
			token: harness.identity.token,
			role: "bridge",
			connectTimeoutMs: 2_000,
			requestTimeoutMs: 2_000,
		});
		const pauseEvents: unknown[] = [];
		bridge.onEvent((event) => pauseEvents.push(event));
		try {
			await controller.connect();
			await bridge.connect();
			const paused = controller.request("pause");
			await waitFor(() => pauseEvents.some((event) => isRecord(event) && event.type === "pause"));
			const first = pauseEvents[0];
			if (!isRecord(first) || typeof first.generation !== "number") {
				throw new Error("pause event did not include a generation");
			}
			const generation = first.generation;
			await expect(
				bridge.request("report_paused", {
					type: "report_paused",
					parentSessionId: harness.identity.parentSessionId,
					childId: harness.identity.subagentId,
					runtimeIdentity: harness.identity.runtimeIdentity,
					generation,
				}),
			).resolves.toBeUndefined();
			await expect(paused).resolves.toMatchObject({ paused: true, idle: false, generation });
		} finally {
			controller.close();
			bridge.close();
			await harness.dispose();
		}
	});

	test("times out pause and releases the child when no ack arrives", async () => {
		const harness = await startFakeRunner({
			piEnv: { FAKE_PI_BUSY: "1" },
			runnerOptions: { requestTimeoutMs: 80 },
		});
		const controller = connectionFor(harness.identity);
		const bridge = new RunnerConnection({
			endpoint: harness.identity.endpoint,
			identity: harness.identity,
			token: harness.identity.token,
			role: "bridge",
			connectTimeoutMs: 2_000,
			requestTimeoutMs: 2_000,
		});
		const events: unknown[] = [];
		bridge.onEvent((event) => events.push(event));
		try {
			await controller.connect();
			await bridge.connect();
			await expect(controller.request("pause")).rejects.toThrow(/Pause handshake timed out/);
			await waitFor(() => events.some((event) => isRecord(event) && event.type === "cancel_pause"));
		} finally {
			controller.close();
			bridge.close();
			await harness.dispose();
		}
	});
});

/** Leaves a bound-then-killed socket file behind, exactly like a crashed runner. */
async function leaveStaleSocket(endpoint: string): Promise<void> {
	const script = `const net=require("node:net");const s=net.createServer();s.listen(process.argv[1],()=>process.kill(process.pid,"SIGKILL"));`;
	const child = spawn(process.execPath, ["-e", script, endpoint], { stdio: "ignore" });
	await new Promise<void>((resolve, reject) => {
		child.once("exit", (code, signal) => {
			if (signal === "SIGKILL" || code === 0) resolve();
			else reject(new Error(`stale socket helper exited with code=${String(code)}`));
		});
		child.once("error", reject);
	});
}
