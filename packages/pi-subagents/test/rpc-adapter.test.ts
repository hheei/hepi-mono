import { describe, expect, test } from "vitest";
import { PiRpcAdapter, PiRpcTimeoutError } from "../src/rpc-adapter.js";
import { spawnFakePi, waitFor } from "./helpers/runner-harness.js";

interface Harness {
	readonly adapter: PiRpcAdapter;
	readonly events: unknown[];
	readonly listenerErrors: unknown[];
	readonly child: ReturnType<typeof spawnFakePi>;
	dispose(): void;
}

function createAdapter(env: Record<string, string> = {}, requestTimeoutMs = 200): Harness {
	const child = spawnFakePi(env);
	const events: unknown[] = [];
	const listenerErrors: unknown[] = [];
	const adapter = new PiRpcAdapter({
		process: child,
		requestTimeoutMs,
		onListenerError: (error) => listenerErrors.push(error),
	});
	adapter.onEvent((event) => events.push(event));
	return {
		adapter,
		events,
		listenerErrors,
		child,
		dispose: (): void => {
			adapter.close(new Error("test teardown"));
			child.kill("SIGKILL");
		},
	};
}

describe("Pi RPC adapter", () => {
	test("round trips forwarded commands and separates events from responses", async () => {
		const harness = createAdapter();
		try {
			await expect(harness.adapter.ready()).resolves.toMatchObject({ sessionId: "fake-session" });
			await expect(harness.adapter.request("prompt", { message: "hi" })).resolves.toBeUndefined();
			await expect(harness.adapter.request("get_entries")).resolves.toMatchObject({
				leafId: "entry-1",
			});
			await expect(harness.adapter.request("get_session_stats")).resolves.toMatchObject({
				turns: 1,
			});
			await expect(harness.adapter.request("abort")).resolves.toBeUndefined();
			await waitFor(() => harness.events.length >= 2);
			expect(harness.events).toContainEqual({ type: "agent_start" });
			expect(harness.events).toContainEqual({ type: "agent_end", messages: [] });
		} finally {
			harness.dispose();
		}
	});

	test("reports Pi command failures as request rejections", async () => {
		const harness = createAdapter();
		try {
			await expect(harness.adapter.request("get_state", { unexpected: true })).rejects.toThrow(
				/does not accept a payload/,
			);
			await expect(harness.adapter.request("prompt", { message: "" })).rejects.toThrow(
				/non-empty message/,
			);
			await expect(
				harness.adapter.request("prompt", { message: "hi", extra: true }),
			).rejects.toThrow(/non-empty message/);
			await expect(harness.adapter.request("get_entries", { since: 1 })).rejects.toThrow(
				/get_entries payload/,
			);
			// Validation failures never reach the child, which is still healthy.
			await expect(harness.adapter.ready()).resolves.toMatchObject({ sessionId: "fake-session" });
		} finally {
			harness.dispose();
		}
	});

	test("times out the in-flight request without leaking a pending promise", async () => {
		const harness = createAdapter({ FAKE_PI_IGNORE: "prompt" });
		try {
			await expect(harness.adapter.request("prompt", { message: "hold" })).rejects.toBeInstanceOf(
				PiRpcTimeoutError,
			);
			await expect(harness.adapter.ready()).resolves.toMatchObject({ sessionId: "fake-session" });
		} finally {
			harness.dispose();
		}
	});

	test("aborts an in-flight request through the AbortSignal", async () => {
		const harness = createAdapter({ FAKE_PI_IGNORE: "prompt" });
		const abort = new AbortController();
		try {
			const pending = harness.adapter.request(
				"prompt",
				{ message: "hold" },
				{ signal: abort.signal },
			);
			abort.abort();
			await expect(pending).rejects.toThrow(/aborted/i);
			await expect(harness.adapter.ready()).resolves.toMatchObject({ sessionId: "fake-session" });
		} finally {
			harness.dispose();
		}
	});

	test("enforces the pending request limit", async () => {
		const child = spawnFakePi({ FAKE_PI_IGNORE: "prompt" });
		const adapter = new PiRpcAdapter({
			process: child,
			requestTimeoutMs: 5_000,
			maxPendingRequests: 1,
		});
		try {
			const first = adapter.request("prompt", { message: "one" });
			await expect(adapter.request("prompt", { message: "two" })).rejects.toThrow(
				/pending request limit/,
			);
			adapter.close(new Error("test teardown"));
			await expect(first).rejects.toThrow(/test teardown/);
		} finally {
			child.kill("SIGKILL");
		}
	});

	test("fails closed on a malformed Pi response", async () => {
		const harness = createAdapter({ FAKE_PI_MALFORMED: "get_state" });
		try {
			await expect(harness.adapter.ready()).rejects.toThrow(/Malformed Pi RPC response/);
			await expect(harness.adapter.request("get_state")).rejects.toThrow(/Malformed/);
		} finally {
			harness.dispose();
		}
	});

	test("rejects a response whose command does not match the request", async () => {
		const harness = createAdapter({ FAKE_PI_COMMAND_OVERRIDE: "get_state" });
		try {
			await expect(harness.adapter.request("get_state")).rejects.toThrow(/command mismatch/);
		} finally {
			harness.dispose();
		}
	});

	test("fails in-flight requests when the Pi child exits", async () => {
		const harness = createAdapter(
			{ FAKE_PI_IGNORE: "prompt", FAKE_PI_EXIT_AFTER_MS: "30", FAKE_PI_EXIT_CODE: "4" },
			5_000,
		);
		try {
			const pending = harness.adapter.request("prompt", { message: "hold" });
			await expect(pending).rejects.toThrow(/exited/i);
			await expect(harness.adapter.ready()).rejects.toThrow(/exited/i);
			await expect(harness.adapter.request("get_state")).rejects.toThrow(/exited/i);
		} finally {
			harness.dispose();
		}
	});

	test("contains listener failures instead of mistaking them for Pi errors", async () => {
		const child = spawnFakePi();
		const listenerErrors: unknown[] = [];
		const adapter = new PiRpcAdapter({
			process: child,
			requestTimeoutMs: 5_000,
			onListenerError: (error) => listenerErrors.push(error),
		});
		adapter.onEvent(() => {
			throw new Error("projector exploded");
		});
		try {
			await adapter.request("prompt", { message: "hi" });
			await expect(adapter.ready()).resolves.toMatchObject({ sessionId: "fake-session" });
			await adapter.request("abort");
			await waitFor(() => listenerErrors.length >= 2);
			expect(listenerErrors.map((error) => (error as Error).message)).toEqual([
				"projector exploded",
				"projector exploded",
			]);
		} finally {
			adapter.close(new Error("test teardown"));
			child.kill("SIGKILL");
		}
	});
});
