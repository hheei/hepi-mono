import { afterEach, describe, expect, it } from "vitest";

import { withMagicContextSubagentLoad } from "../src/magic-context-compat.js";

const originalEnv = process.env.MAGIC_CONTEXT_PI_SUBAGENT;

afterEach(() => {
	if (originalEnv === undefined) delete process.env.MAGIC_CONTEXT_PI_SUBAGENT;
	else process.env.MAGIC_CONTEXT_PI_SUBAGENT = originalEnv;
});

describe("Magic Context subagent compatibility", () => {
	it("marks child extension loading and restores the environment", async () => {
		delete process.env.MAGIC_CONTEXT_PI_SUBAGENT;

		await withMagicContextSubagentLoad(async () => {
			expect(process.env.MAGIC_CONTEXT_PI_SUBAGENT).toBe("1");
		});

		expect(process.env.MAGIC_CONTEXT_PI_SUBAGENT).toBeUndefined();
	});

	it("keeps the marker through nested loads", async () => {
		process.env.MAGIC_CONTEXT_PI_SUBAGENT = "parent";

		await withMagicContextSubagentLoad(async () => {
			await withMagicContextSubagentLoad(async () => {
				expect(process.env.MAGIC_CONTEXT_PI_SUBAGENT).toBe("1");
			});
			expect(process.env.MAGIC_CONTEXT_PI_SUBAGENT).toBe("1");
		});

		expect(process.env.MAGIC_CONTEXT_PI_SUBAGENT).toBe("parent");
	});
});
