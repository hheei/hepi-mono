import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HepiLifecycleController } from "../src/core/runtime/lifecycle.js";
import { HepiRegistry } from "../src/core/runtime/registry.js";

const fakePi = {} as ExtensionAPI;
const fakeContext = (sessionId: string) =>
	({ sessionManager: { getSessionId: () => sessionId } }) as unknown as ExtensionContext;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("HePiRegistry", () => {
	test("sorts registrations and rejects collisions", () => {
		const registry = new HepiRegistry();
		registry.registerModule({ id: "zeta" });
		registry.registerModule({ id: "alpha" });
		expect(registry.listModules().map(({ id }) => id)).toEqual(["alpha", "zeta"]);
		expect(() => registry.registerModule({ id: "alpha" })).toThrow(
			"HePi module id collision: alpha",
		);
	});

	test("narrows command registrations at runtime", () => {
		const registry = new HepiRegistry();
		registry.registerModule({ id: "valid", commands: ["open"] });
		registry.registerModule({ id: "invalid", commands: [1] });

		expect(registry.findModuleForCommand("open")?.id).toBe("valid");
		expect(registry.findModuleForCommand("1")).toBeUndefined();
	});

	test("cleans all resources in reverse order and isolates registries", async () => {
		const first = new HepiRegistry();
		const second = new HepiRegistry();
		const calls: string[] = [];
		first.registerLifecycle({
			id: "first",
			cleanup: () => {
				calls.push("first");
			},
		});
		first.registerLifecycle({
			id: "second",
			cleanup: () => {
				calls.push("second");
				throw new Error("cleanup failed");
			},
		});
		second.registerModule({ id: "other" });

		const failures = await first.cleanup();
		expect(calls).toEqual(["second", "first"]);
		expect(failures).toHaveLength(1);
		expect(second.listModules().map(({ id }) => id)).toEqual(["other"]);
	});
});

describe("HePiLifecycleController", () => {
	test("reports cleanup failures after running every cleanup", async () => {
		const calls: string[] = [];
		const controller = new HepiLifecycleController({
			onStart: (runtime) => {
				runtime.registry.registerLifecycle({
					id: "first",
					cleanup: () => {
						calls.push("first");
					},
				});
				runtime.registry.registerLifecycle({
					id: "second",
					cleanup: () => {
						calls.push("second");
						throw new Error("cleanup failed");
					},
				});
			},
		});
		await controller.start(fakePi, fakeContext("a"));

		await expect(controller.shutdown()).rejects.toThrow("HEPI cleanup failed: second");
		expect(calls).toEqual(["second", "first"]);
		expect(controller.current).toBeUndefined();
		await expect(controller.shutdown()).resolves.toBeUndefined();
	});

	test("replaces active session and makes shutdown idempotent", async () => {
		const started: string[] = [];
		const controller = new HepiLifecycleController({
			onStart: (runtime) => {
				started.push(runtime.ctx.sessionManager.getSessionId());
			},
		});
		await controller.start(fakePi, fakeContext("a"));
		const first = controller.current;
		await controller.start(fakePi, fakeContext("b"));
		expect(first).not.toBe(controller.current);
		expect(started).toEqual(["a", "b"]);
		await controller.shutdown();
		await controller.shutdown();
		expect(controller.current).toBeUndefined();
	});

	test("waits for pending start before shutdown cleanup", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const events: string[] = [];
		const controller = new HepiLifecycleController({
			onStart: async (runtime) => {
				const sessionId = runtime.ctx.sessionManager.getSessionId();
				events.push(`${sessionId}:start`);
				runtime.registry.registerLifecycle({
					id: "initial",
					cleanup: () => {
						events.push("cleanup:initial");
					},
				});
				entered.resolve(undefined);
				await release.promise;
				events.push(`${sessionId}:resume`);
				runtime.registry.registerLifecycle({
					id: "late",
					cleanup: () => {
						events.push("cleanup:late");
					},
				});
			},
		});

		const startPromise = controller.start(fakePi, fakeContext("a"));
		await entered.promise;
		const shutdownPromise = controller.shutdown();
		expect(events).toEqual(["a:start"]);

		release.resolve(undefined);
		await startPromise;
		await shutdownPromise;
		expect(events).toEqual(["a:start", "a:resume", "cleanup:late", "cleanup:initial"]);
		expect(controller.current).toBeUndefined();
	});

	test("serializes replacement start behind pending start cleanup", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const events: string[] = [];
		const controller = new HepiLifecycleController({
			onStart: async (runtime) => {
				const sessionId = runtime.ctx.sessionManager.getSessionId();
				events.push(`${sessionId}:start`);
				if (sessionId === "a") {
					runtime.registry.registerLifecycle({
						id: "a",
						cleanup: () => {
							events.push("cleanup:a");
						},
					});
					entered.resolve(undefined);
					await release.promise;
					events.push("a:resume");
				}
			},
		});

		const firstStart = controller.start(fakePi, fakeContext("a"));
		await entered.promise;
		const replacementStart = controller.start(fakePi, fakeContext("b"));
		expect(events).toEqual(["a:start"]);

		release.resolve(undefined);
		await Promise.all([firstStart, replacementStart]);
		expect(events).toEqual(["a:start", "a:resume", "cleanup:a", "b:start"]);
		expect(controller.current?.ctx.sessionManager.getSessionId()).toBe("b");
		await controller.shutdown();
	});

	test("recovers transition queue after rejected start", async () => {
		const entered = deferred<void>();
		const rejectStart = deferred<void>();
		const events: string[] = [];
		let attempts = 0;
		const controller = new HepiLifecycleController({
			onStart: async (runtime) => {
				attempts += 1;
				const sessionId = runtime.ctx.sessionManager.getSessionId();
				if (attempts === 1) {
					entered.resolve(undefined);
					await rejectStart.promise;
					throw new Error("start failed");
				}
				events.push(`${sessionId}:start`);
			},
			onShutdown: (runtime) => {
				events.push(`cleanup:${runtime.ctx.sessionManager.getSessionId()}`);
			},
		});

		const firstStart = controller.start(fakePi, fakeContext("a"));
		await entered.promise;
		rejectStart.resolve(undefined);
		try {
			await firstStart;
			throw new Error("start unexpectedly resolved");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("start failed");
		}

		await controller.start(fakePi, fakeContext("b"));
		expect(events).toEqual(["cleanup:a", "b:start"]);
		expect(controller.current?.ctx.sessionManager.getSessionId()).toBe("b");
		await controller.shutdown();
	});
});
