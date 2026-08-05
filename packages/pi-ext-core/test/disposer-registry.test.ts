import { expect, test } from "bun:test";
import { createDisposerRegistry } from "../src/disposer-registry.js";

test("cleans resources in reverse order and continues after failures", async () => {
	const registry = createDisposerRegistry();
	const calls: string[] = [];
	registry.add("first", () => {
		calls.push("first");
	});
	registry.add("second", () => {
		calls.push("second");
		throw new Error("second failed");
	});

	const failures = await registry.cleanup();

	expect(calls).toEqual(["second", "first"]);
	expect(failures).toEqual([{ id: "second", error: expect.any(Error) }]);
});
