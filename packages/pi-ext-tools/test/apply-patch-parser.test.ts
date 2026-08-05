import { describe, expect, test } from "bun:test";
import {
	compileV4aUpdateToUnifiedDiff,
	findV4aPatchConflicts,
	parseV4aPatch,
	type V4aAddOperation,
	type V4aPatchOperation,
} from "../src/apply-patch/index.js";

describe("V4A patch parser", () => {
	test("parses add, update, delete, and move operations", () => {
		const patch = parseV4aPatch(
			"*** Begin Patch\n" +
				"*** Add File: new.txt\n+one\n+two\n" +
				"*** Update File: old.txt\n*** Move to: moved.txt\n-old\n+new\n" +
				"*** Delete File: gone.txt\n" +
				"*** End Patch",
		);
		const expected: readonly V4aPatchOperation[] = [
			{ kind: "add", path: "new.txt", content: "one\ntwo\n" },
			{
				kind: "update",
				path: "old.txt",
				moveTo: "moved.txt",
				hunks: [
					{
						lines: [
							{ kind: "remove", text: "old\n" },
							{ kind: "add", text: "new\n" },
						],
					},
				],
			},
			{ kind: "delete", path: "gone.txt" },
		];
		expect(patch.operations).toEqual(expected);
	});

	test("rejects repeated envelope markers with actionable errors", () => {
		expect(() =>
			parseV4aPatch(
				"*** Begin Patch\n*** Update File: *** Begin Patch\n*** Update File: file.txt\n-old\n+new\n*** End Patch",
			),
		).toThrow("patch envelope markers cannot be used as file paths");
		expect(() =>
			parseV4aPatch(
				"*** Begin Patch\n*** Update File: file.txt\n*** Begin Patch\n-old\n+new\n*** End Patch",
			),
		).toThrow("Begin Patch must appear only as the first line of the patch");
	});

	test("preserves literal whitespace and rejects malformed full input", () => {
		const parsed = parseV4aPatch("*** Begin Patch\n*** Add File: x\n+  keep  \n*** End Patch");
		const operation = parsed.operations[0];
		if (operation === undefined || operation.kind !== "add") throw new Error("expected add");
		const add: V4aAddOperation = operation;
		expect(add).toMatchObject({ content: "  keep  \n" });
		expect(() =>
			parseV4aPatch("*** Begin Patch\n*** Add File: x\n+ok\n*** Nope\n*** End Patch"),
		).toThrow();
	});

	test("accepts harmless outer formatting without relaxing inner grammar", () => {
		const patch = parseV4aPatch(
			"\uFEFF\n```patch\n\n*** Begin Patch\n*** Add File: x\n+keep\n*** End Patch\n\n```\n",
		);
		expect(patch.operations).toEqual([{ kind: "add", path: "x", content: "keep\n" }]);
		expect(() =>
			parseV4aPatch(
				"```patch\n*** Begin Patch\n*** Add File: x\n+keep\n*** Nope\n*** End Patch\n```",
			),
		).toThrow();
	});

	test("reports duplicate and touch-conflicting paths", () => {
		const duplicate = parseV4aPatch(
			"*** Begin Patch\n*** Delete File: x\n*** Add File: x\n+v\n*** End Patch",
		);
		const repeatedUpdate = parseV4aPatch(
			"*** Begin Patch\n*** Update File: x\n-a\n+b\n*** Update File: x\n-b\n+c\n*** End Patch",
		);
		const selfMove = parseV4aPatch(
			"*** Begin Patch\n*** Update File: x\n*** Move to: x\n-a\n+b\n*** End Patch",
		);
		const moveTarget = parseV4aPatch(
			"*** Begin Patch\n*** Update File: x\n*** Move to: y\n-a\n+b\n*** Add File: y\n+v\n*** End Patch",
		);
		expect(findV4aPatchConflicts(duplicate)).toEqual([]);
		expect(findV4aPatchConflicts(repeatedUpdate)).toEqual([
			{ path: "x", operationIndices: [0, 1], message: "path touched more than once: x" },
		]);
		expect(findV4aPatchConflicts(selfMove)).toEqual([
			{ path: "x", operationIndices: [0], message: "path touched more than once: x" },
		]);
		expect(findV4aPatchConflicts(moveTarget)).toEqual([
			{ path: "y", operationIndices: [0, 1], message: "path touched more than once: y" },
		]);
	});

	test("rejects no-op updates", () => {
		expect(() =>
			parseV4aPatch("*** Begin Patch\n*** Update File: x\n  same\n*** End Patch"),
		).toThrow();
	});

	test("compiles update into unified diff with synthetic ranges", () => {
		const operation: V4aPatchOperation | undefined = parseV4aPatch(
			"*** Begin Patch\n*** Update File: x\n-old\n+new\n*** End Patch",
		).operations[0];
		if (operation === undefined || operation.kind !== "update") throw new Error("expected update");
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
