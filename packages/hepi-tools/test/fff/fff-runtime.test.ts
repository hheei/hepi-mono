import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { FffRuntime } from "../../src/fff/fff.js";

describe("FFF runtime", () => {
	test("destroys a finder that finishes initialization after disposal", async () => {
		const runtime = new FffRuntime("/tmp");
		let resolveInitialization: (result: unknown) => void = () => undefined;
		const pendingInitialization = new Promise<unknown>((resolve) => {
			resolveInitialization = resolve;
		});
		(runtime as unknown as { initPromise: Promise<unknown> }).initPromise = pendingInitialization;
		const ensuring = runtime.ensure();
		runtime.dispose();
		const destroyed: string[] = [];
		resolveInitialization(Result.ok({ destroy: () => destroyed.push("destroyed") } as never));
		const result = await ensuring;
		expect(result.isErr()).toBe(true);
		expect(destroyed).toEqual(["destroyed"]);
	});
});
