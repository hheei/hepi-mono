import { describe, expect, test } from "bun:test";
import { createRtkFeature } from "../../src/rtk/feature.js";

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
});
