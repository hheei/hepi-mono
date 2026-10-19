import { describe, expect, test } from "vitest";
import { runJsDiffUpdate } from "../src/apply-patch/jsdiff.js";
import { parseV4aPatch } from "../src/apply-patch/parser.js";

const operation = parseV4aPatch(
	"*** Begin Patch\n*** Update File: value.txt\n*** Move to: moved.txt\n@@\n-one\n+ONE\n@@\n-four\n+FOUR\n*** End Patch",
).operations[0];
if (operation?.kind !== "update") throw new Error("expected update fixture");
const update = { operation, fuzzFactor: 0 };

describe("apply-patch jsdiff worker", () => {
	test("returns prepared bytes, outcomes and snapshots without mutating input", async () => {
		const before = new TextEncoder().encode("one\ntwo\nthree\nfour\n");
		const prepared = await runJsDiffUpdate({ ...update, before });
		expect(prepared.outcomes).toEqual([
			{ kind: "applied", hunkIndex: 1, startLine: 1, length: 1, match: "exact" },
			{ kind: "applied", hunkIndex: 2, startLine: 4, length: 1, match: "exact" },
		]);
		expect(prepared.rejected).toEqual([]);
		expect(prepared.mode).toBe("exact");
		expect(prepared.addedLines).toBe(2);
		expect(prepared.removedLines).toBe(2);
		expect(new TextDecoder().decode(prepared.after)).toBe("ONE\ntwo\nthree\nFOUR\n");
		expect(new TextDecoder().decode(before)).toBe("one\ntwo\nthree\nfour\n");
		expect(prepared.snapshots).toEqual([
			{
				path: "moved.txt",
				hunkIndex: 1,
				startLine: 1,
				afterStartLine: 1,
				before: ["one", "two", "three", "four"],
				after: ["ONE", "two", "three", "four"],
			},
			{
				path: "moved.txt",
				hunkIndex: 2,
				startLine: 1,
				afterStartLine: 1,
				before: ["ONE", "two", "three", "four"],
				after: ["ONE", "two", "three", "FOUR"],
			},
		]);
	});

	test("propagates worker errors for invalid UTF-8", async () => {
		await expect(
			runJsDiffUpdate({ ...update, before: Uint8Array.of(0xff, 0xfe, 0x00) }),
		).rejects.toThrow("not valid UTF-8");
	});

	test.each(["before launch", "after launch"] as const)("cancels %s", async (timing) => {
		const controller = new AbortController();
		const reason = new Error("cancelled");
		if (timing === "before launch") controller.abort(reason);
		const pending = runJsDiffUpdate({
			...update,
			before: new TextEncoder().encode("one\ntwo\nthree\nfour\n"),
			signal: controller.signal,
		});
		// runJsDiffUpdate creates its worker synchronously before returning this promise.
		if (timing === "after launch") controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
	});
});
