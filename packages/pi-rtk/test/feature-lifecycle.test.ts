import { describe, expect, test } from "bun:test";
import { createRtkFeature } from "../src/rtk/feature.js";

describe("RTK feature lifecycle", () => {
	test("registers host handlers only once across sessions", async () => {
		const handlers = new Map<string, unknown[]>();
		const pi = {
			on: (event: string, handler: unknown) => {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
			exec: async (command: string) => ({
				code: 0,
				stdout: command === "which" ? "/usr/local/bin/rtk\n" : "rtk 1.0\n",
				stderr: "",
				killed: false,
			}),
		};
		let sessionId = "first";
		const runtime = {
			pi,
			ctx: {
				cwd: `/tmp/pi-rtk-lifecycle-${Date.now()}`,
				hasUI: false,
				ui: { notify: () => undefined },
				sessionManager: { getSessionId: () => sessionId },
			},
		};
		const feature = createRtkFeature();

		await feature.start(runtime as never);
		feature.dispose("first");
		sessionId = "second";
		await feature.start(runtime as never);

		expect(
			Object.fromEntries([...handlers].map(([event, values]) => [event, values.length])),
		).toEqual({
			tool_call: 1,
			tool_result: 1,
			tool_execution_start: 1,
			tool_execution_update: 1,
			tool_execution_end: 1,
		});
	});

	test("aborts refresh on dispose and refreshes with a replacement owner", async () => {
		const signals: AbortSignal[] = [];
		let resolverCalls = 0;
		const pi = {
			on: () => undefined,
			exec: async (command: string, _args: string[], options?: { signal?: AbortSignal }) => {
				const signal = options?.signal;
				if (signal) signals.push(signal);
				if (command === "which" && ++resolverCalls === 1) {
					await new Promise<void>((_resolve, reject) => {
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						signal?.addEventListener("abort", () => reject(new Error("aborted")), {
							once: true,
						});
					});
				}
				return {
					code: 0,
					stdout: command === "which" ? "/usr/local/bin/rtk\n" : "rtk 1.0\n",
					stderr: "",
					killed: false,
				};
			},
		};
		let sessionId = "first";
		const runtime = {
			pi,
			ctx: {
				cwd: `/tmp/pi-rtk-abort-${Date.now()}`,
				hasUI: false,
				ui: { notify: () => undefined },
				sessionManager: { getSessionId: () => sessionId },
			},
		};
		const feature = createRtkFeature();
		const firstStart = feature.start(runtime as never);
		while (signals.length === 0) await Bun.sleep(0);
		feature.dispose("first");
		await firstStart;

		sessionId = "second";
		await feature.start(runtime as never);

		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		expect(feature.getStatus().rtkAvailable).toBe(true);
	});

	test("ignores refresh results from a replaced session", async () => {
		let releaseOldRefresh: () => void = () => undefined;
		const oldRefreshGate = new Promise<void>((resolve) => {
			releaseOldRefresh = resolve;
		});
		let resolverCalls = 0;
		const pi = {
			on: () => undefined,
			exec: async (command: string) => {
				if (command === "which") {
					const call = ++resolverCalls;
					if (call === 2) await oldRefreshGate;
					const path = call === 2 ? "/old/rtk" : "/new/rtk";
					return { code: 0, stdout: `${path}\n`, stderr: "", killed: false };
				}
				return {
					code: command === "/old/rtk" ? 1 : 0,
					stdout: command === "/old/rtk" ? "" : "rtk 1.0\n",
					stderr: command === "/old/rtk" ? "stale failure" : "",
					killed: false,
				};
			},
		};
		let sessionId = "first";
		const runtime = {
			pi,
			ctx: {
				cwd: `/tmp/pi-rtk-refresh-${Date.now()}`,
				hasUI: false,
				ui: { notify: () => undefined },
				sessionManager: { getSessionId: () => sessionId },
			},
		};
		const feature = createRtkFeature();
		await feature.start(runtime as never);

		const staleRefresh = feature.refresh(true);
		while (resolverCalls < 2) await Bun.sleep(0);
		feature.dispose("first");
		sessionId = "second";
		await feature.start(runtime as never);
		releaseOldRefresh();
		await staleRefresh;

		expect(feature.getStatus().rtkAvailable).toBe(true);
		expect(feature.getStatus().rtkExecutablePath).toBe("/new/rtk");
	});
});
