import { describe, expect, test } from "bun:test";

import { EmbeddingRuntime } from "../src/runtime.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("EmbeddingRuntime local provider", () => {
	test("qualifies local model identity", async () => {
		const runtime = new EmbeddingRuntime({
			loadLocal: async () => ({ embed: async () => new Float32Array([1]) }),
		});
		const lease = await runtime.acquire({ provider: "local", model: "shared-model" });
		if (lease === undefined) throw new Error("Expected local lease");
		expect(lease.provider.snapshot()?.modelIdentity).toBe("local:shared-model");
		await lease.release();
	});

	test("merges local leases and disposes only after the final release", async () => {
		let loads = 0;
		let disposals = 0;
		const runtime = new EmbeddingRuntime({
			loadLocal: async () => {
				loads += 1;
				return {
					embed: async () => new Float32Array([1, 2]),
					dispose: () => {
						disposals += 1;
					},
				};
			},
		});

		const first = await runtime.acquire({});
		const second = await runtime.acquire({ provider: "local" });
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (first === undefined || second === undefined) throw new Error("Expected local leases");
		expect(loads).toBe(0);

		expect(await first.provider.embed("one", "query", new AbortController().signal)).toEqual(
			new Float32Array([1, 2]),
		);
		expect(await second.provider.embed("two", "passage", new AbortController().signal)).toEqual(
			new Float32Array([1, 2]),
		);
		expect(loads).toBe(1);
		await first.release();
		expect(disposals).toBe(0);
		await second.release();
		expect(disposals).toBe(1);
		expect(
			await second.provider.embed("after", "query", new AbortController().signal),
		).toBeUndefined();
	});

	test("returns unavailable results and does not load for an aborted call", async () => {
		let loads = 0;
		const runtime = new EmbeddingRuntime({
			loadLocal: async () => {
				loads += 1;
				throw new Error("runtime unavailable");
			},
		});
		expect(await runtime.acquire({ provider: "off" })).toBeUndefined();
		const lease = await runtime.acquire({});
		if (lease === undefined) throw new Error("Expected local lease");
		const controller = new AbortController();
		controller.abort();
		expect(await lease.provider.embed("cancelled", "query", controller.signal)).toBeUndefined();
		expect(loads).toBe(0);
		expect(
			await lease.provider.embed("unavailable", "query", new AbortController().signal),
		).toBeUndefined();
		expect(loads).toBe(1);
		await lease.release();
	});

	test("release waits for an in-flight pipeline call", async () => {
		let finish: (() => void) | undefined;
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolveStarted) => {
			markStarted = resolveStarted;
		});
		let disposed = false;
		const runtime = new EmbeddingRuntime({
			loadLocal: async () => ({
				embed: async () =>
					new Promise<Float32Array>((resolveEmbed) => {
						markStarted();
						finish = () => resolveEmbed(new Float32Array([1]));
					}),
				dispose: () => {
					disposed = true;
				},
			}),
		});
		const lease = await runtime.acquire({});
		if (lease === undefined) throw new Error("Expected local lease");
		const controller = new AbortController();
		const embedding = lease.provider.embed("in-flight", "query", controller.signal);
		await started;
		const released = lease.release();
		expect(disposed).toBeFalse();
		controller.abort();
		expect(await embedding).toBeUndefined();
		expect(disposed).toBeFalse();
		if (finish === undefined) throw new Error("Expected pipeline call");
		finish();
		await released;
		expect(disposed).toBeTrue();
	});
});

describe("EmbeddingRuntime Synapse provider", () => {
	test("shares one connection and validates batch response identity", async () => {
		let connections = 0;
		let closes = 0;
		const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
		const runtime = new EmbeddingRuntime({
			connectSynapse: async () => {
				connections += 1;
				return {
					call: async (method, params) => {
						requests.push({ method, params });
						if (method === "models.list") {
							return {
								models: [{ model: "shared-model", fingerprint: "fixed", table_epoch: 4, dims: 2 }],
							};
						}
						return {
							items: [
								{ id: "a", contentHash: HASH_A, vector: [1, 0] },
								{ id: "b", contentHash: HASH_B, vector: [0, 1] },
							],
						};
					},
					close: () => {
						closes += 1;
					},
				};
			},
		});
		const config = {
			provider: "synapse" as const,
			connectionFile: "/tmp/subc.json",
			projectRoot: "/tmp/project",
			session: "session-a",
			model: "shared-model",
			metadata: { source: "test" },
		};
		const first = await runtime.acquire(config);
		const second = await runtime.acquire(config);
		if (first === undefined || second === undefined) throw new Error("Expected Synapse leases");
		const vectors = await first.provider.embedBatch(
			[
				{ id: "a", text: "one", contentHash: HASH_A },
				{ id: "b", text: "two", contentHash: HASH_B },
			],
			"passage",
			new AbortController().signal,
		);
		expect(vectors?.get("a")).toEqual(new Float32Array([1, 0]));
		expect(connections).toBe(1);
		const batch = requests.find((request) => request.method === "embed.batch");
		expect(batch?.params).toEqual({
			model: "shared-model",
			required_fingerprint: "fixed",
			required_epoch: 4,
			allow_equivalent: false,
			accept_declared: false,
			purpose: "passage",
			metadata: { source: "test" },
			items: [
				{ id: "a", text: "one", contentHash: HASH_A },
				{ id: "b", text: "two", contentHash: HASH_B },
			],
		});
		await first.release();
		expect(closes).toBe(0);
		await second.release();
		expect(closes).toBe(1);
	});

	test("shares one Synapse client across session identities on one connection file", async () => {
		let connections = 0;
		const runtime = new EmbeddingRuntime({
			connectSynapse: async () => {
				connections += 1;
				return {
					call: async () => ({ models: [] }),
					close: () => {},
				};
			},
		});
		const first = await runtime.acquire({
			provider: "synapse",
			connectionFile: "/tmp/subc.json",
			projectRoot: "/tmp/project-a",
			session: "session-a",
			model: "model-a",
		});
		const second = await runtime.acquire({
			provider: "synapse",
			connectionFile: "/tmp/subc.json",
			projectRoot: "/tmp/project-b",
			session: "session-b",
			model: "model-b",
		});
		if (first === undefined || second === undefined) throw new Error("Expected Synapse leases");

		await first.provider.embed("one", "query", new AbortController().signal);
		await second.provider.embed("two", "query", new AbortController().signal);
		expect(connections).toBe(1);
		await first.release();
		await second.release();
	});

	test("drops malformed Synapse batch results and validates caller batch IDs", async () => {
		const runtime = new EmbeddingRuntime({
			connectSynapse: async () => ({
				call: async (method) => {
					if (method === "models.list")
						return { models: [{ model: "model", fingerprint: "fixed", epoch: 1 }] };
					return { items: [{ id: "wrong", contentHash: HASH_A, vector: [1] }] };
				},
				close: () => {},
			}),
		});
		const lease = await runtime.acquire({
			provider: "synapse",
			connectionFile: "/tmp/subc.json",
			projectRoot: "/tmp/project",
			session: "session-a",
			model: "model",
		});
		if (lease === undefined) throw new Error("Expected Synapse lease");
		expect(
			await lease.provider.embedBatch(
				[{ id: "expected", text: "one", contentHash: HASH_A }],
				"passage",
				new AbortController().signal,
			),
		).toBeUndefined();
		await expect(
			lease.provider.embedBatch(
				[
					{ id: "duplicate", text: "one", contentHash: HASH_A },
					{ id: "duplicate", text: "two", contentHash: HASH_B },
				],
				"passage",
				new AbortController().signal,
			),
		).rejects.toThrow("Duplicate embedding batch ID");
		await lease.release();
	});
});
