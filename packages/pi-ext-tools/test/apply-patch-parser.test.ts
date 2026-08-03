import { describe, expect, test } from "bun:test";
import { compileV4aUpdateToUnifiedDiff, parseV4aPatch } from "../src/apply-patch/index.js";

describe("V4A patch parser", () => {
	test("parses add, update, delete, and move operations", () => {
		const patch = parseV4aPatch(
			"*** Begin Patch\n" +
				"*** Add File: new.txt\n+one\n+two\n" +
				"*** Update File: old.txt\n*** Move to: moved.txt\n-old\n+new\n" +
				"*** Delete File: gone.txt\n" +
				"*** End Patch",
		);
		expect(patch.operations).toEqual([
			{ kind: "add", path: "new.txt", content: "one\ntwo\n" },
			{
				kind: "update",
				path: "old.txt",
				moveTo: "moved.txt",
				hunks: [
					[
						{ kind: "remove", text: "old\n" },
						{ kind: "add", text: "new\n" },
					],
				].map((lines) => ({ lines })),
			},
			{ kind: "delete", path: "gone.txt" },
		]);
	});

	test("preserves literal whitespace and rejects malformed full input", () => {
		const parsed = parseV4aPatch("*** Begin Patch\n*** Add File: x\n+  keep  \n*** End Patch");
		expect(parsed.operations[0]).toMatchObject({ content: "  keep  \n" });
		expect(() =>
			parseV4aPatch("*** Begin Patch\n*** Add File: x\n+ok\n*** Nope\n*** End Patch"),
		).toThrow();
	});

	test("rejects duplicate and touch-conflicting paths", () => {
		expect(() =>
			parseV4aPatch("*** Begin Patch\n*** Delete File: x\n*** Add File: x\n+v\n*** End Patch"),
		).toThrow();
		expect(() =>
			parseV4aPatch(
				"*** Begin Patch\n*** Update File: x\n*** Move to: y\n-a\n+b\n*** Add File: y\n+v\n*** End Patch",
			),
		).toThrow();
	});

	test("rejects no-op updates", () => {
		expect(() =>
			parseV4aPatch("*** Begin Patch\n*** Update File: x\n  same\n*** End Patch"),
		).toThrow();
	});

	test("compiles update into unified diff with synthetic ranges", () => {
		const operation = parseV4aPatch(
			"*** Begin Patch\n*** Update File: x\n-old\n+new\n*** End Patch",
		).operations[0];
		expect(operation.kind).toBe("update");
		if (operation.kind !== "update") throw new Error("expected update");
		expect(compileV4aUpdateToUnifiedDiff(operation)).toBe(
			"--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new\n",
		);
	});

	test("keeps moved update diff on source path", () => {
		const operation = parseV4aPatch(
			"*** Begin Patch\n*** Update File: old\n*** Move to: new\n-old\n+new\n*** End Patch",
		).operations[0];
		if (operation === undefined || operation.kind !== "update") throw new Error("expected update");
		expect(compileV4aUpdateToUnifiedDiff(operation)).toContain("+++ b/old\n");
	});
});
