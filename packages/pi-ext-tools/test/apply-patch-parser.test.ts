import { describe, expect, test } from "vitest";
import {
	compileV4aUpdateToUnifiedDiff,
	createV4aPreviewCursor,
	findV4aPatchConflicts,
	MAX_V4A_HUNK_LINES,
	MAX_V4A_HUNKS_PER_UPDATE,
	MAX_V4A_OPERATIONS,
	MAX_V4A_PATCH_BYTES,
	MAX_V4A_PATH_BYTES,
	MAX_V4A_PATH_SEGMENT_BYTES,
	parseV4aPatch,
	parseV4aPatchProgressively,
	previewV4aPatchFileCount,
	previewV4aPatchPrefix,
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

	test("preserves consecutive anchors and EOF constraints while allowing pure moves", () => {
		const operation = parseV4aPatch(
			"*** Begin Patch\n" +
				"*** Update File: source.txt\n" +
				"*** Move to: destination.txt\n" +
				"*** End Patch",
		).operations[0];
		if (operation === undefined || operation.kind !== "update") throw new Error("expected update");
		expect(operation).toMatchObject({ moveTo: "destination.txt", hunks: [] });

		const constrained = parseV4aPatch(
			"*** Begin Patch\n*** Update File: value.txt\n@@ outer\n@@ inner\n-old\n+new\n*** End of File\n*** End Patch",
		).operations[0];
		if (constrained === undefined || constrained.kind !== "update")
			throw new Error("expected update");
		expect(constrained.hunks).toEqual([
			{
				anchor: "inner",
				anchors: ["outer", "inner"],
				endOfFile: true,
				lines: [
					{ kind: "remove", text: "old\n" },
					{ kind: "add", text: "new\n" },
				],
			},
		]);
		for (const tail of ["+new", "*** End of File", "@@ later"]) {
			expect(() =>
				parseV4aPatch(
					`*** Begin Patch\n*** Update File: value.txt\n-old\n*** End of File\n${tail}\n*** End Patch`,
				),
			).toThrow("End of File must be the final update constraint at line 5");
		}
	});

	test("reports each complete operation before completing the patch", async (): Promise<void> => {
		const reported: string[] = [];
		const patch = await parseV4aPatchProgressively(
			"*** Begin Patch\n" +
				"*** Add File: first.txt\n+one\n" +
				"*** Update File: second.txt\n-old\n+new\n" +
				"*** End Patch",
			async (operation, index) => {
				reported.push(`${index}:${operation.kind}:${operation.path}`);
			},
		);
		expect(reported).toEqual(["0:add:first.txt", "1:update:second.txt"]);
		expect(patch.operations).toHaveLength(2);
	});

	test("keeps the first Begin Patch and last End Patch", () => {
		expect(() =>
			parseV4aPatch(
				"*** Begin Patch\n*** Update File: *** Begin Patch\n*** Update File: file.txt\n-old\n+new\n*** End Patch",
			),
		).toThrow("patch envelope markers cannot be used as file paths");
		expect(
			parseV4aPatch(
				"*** Begin Patch\n*** Update File: file.txt\n*** Begin Patch\n-old\n+new\n*** End Patch",
			).operations,
		).toEqual([
			{
				kind: "update",
				path: "file.txt",
				hunks: [
					{
						lines: [
							{ kind: "remove", text: "old\n" },
							{ kind: "add", text: "new\n" },
						],
					},
				],
			},
		]);
		expect(
			parseV4aPatch(
				"*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch\n*** Begin Patch\n*** Add File: b.txt\n+b\n*** End Patch",
			).operations,
		).toEqual([
			{ kind: "add", path: "a.txt", content: "a\n" },
			{ kind: "add", path: "b.txt", content: "b\n" },
		]);
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

	test("accepts absolute and workspace-escaping paths", () => {
		const patch = parseV4aPatch(
			"*** Begin Patch\n" +
				"*** Add File: /tmp/value.txt\n+value\n" +
				"*** Update File: ../outside.txt\n-old\n+new\n" +
				"*** End Patch",
		);
		expect(patch.operations.map((operation) => operation.path)).toEqual([
			"/tmp/value.txt",
			"../outside.txt",
		]);
	});

	test("reports path conflicts without rejecting ordered same-path operations", () => {
		const cases = [
			{
				patch: "*** Begin Patch\n*** Delete File: x\n*** Add File: x\n+v\n*** End Patch",
				conflicts: [],
			},
			{
				patch:
					"*** Begin Patch\n*** Update File: x\n-a\n+b\n*** Update File: x\n-b\n+c\n*** End Patch",
				conflicts: [],
			},
			{
				patch: "*** Begin Patch\n*** Update File: x\n*** Move to: x\n-a\n+b\n*** End Patch",
				conflicts: [
					{ path: "x", operationIndices: [0], message: "path touched more than once: x" },
				],
			},
			{
				patch:
					"*** Begin Patch\n*** Update File: x\n*** Move to: y\n-a\n+b\n*** Add File: y\n+v\n*** End Patch",
				conflicts: [
					{ path: "y", operationIndices: [0, 1], message: "path touched more than once: y" },
				],
			},
		];
		for (const { patch, conflicts } of cases)
			expect(findV4aPatchConflicts(parseV4aPatch(patch))).toEqual(conflicts);
	});

	test("rejects no-op updates", () => {
		expect(() =>
			parseV4aPatch("*** Begin Patch\n*** Update File: x\n  same\n*** End Patch"),
		).toThrow();
	});

	test("rejects patches beyond the hard input limits", () => {
		expect(() => parseV4aPatch("x".repeat(MAX_V4A_PATCH_BYTES + 1))).toThrow("byte limit");
		const operations = Array.from(
			{ length: MAX_V4A_OPERATIONS + 1 },
			(_, index) => `*** Add File: ${index}.txt\n+value\n`,
		).join("");
		expect(() => parseV4aPatch(`*** Begin Patch\n${operations}*** End Patch`)).toThrow(
			"operation limit",
		);
	});

	test("rejects updates beyond hunk and hunk-line limits", () => {
		const hunks = Array.from(
			{ length: MAX_V4A_HUNKS_PER_UPDATE + 1 },
			() => "@@\n-old\n+new\n",
		).join("");
		expect(() =>
			parseV4aPatch(`*** Begin Patch\n*** Update File: value.txt\n${hunks}*** End Patch`),
		).toThrow("hunk limit");
		const lines = Array.from({ length: MAX_V4A_HUNK_LINES + 1 }, () => " old\n").join("");
		expect(() =>
			parseV4aPatch(`*** Begin Patch\n*** Update File: value.txt\n${lines}+new\n*** End Patch`),
		).toThrow("lines per hunk limit");
	});

	test("rejects path segments and paths beyond platform-safe byte limits", () => {
		const oversizedSegment = "a".repeat(MAX_V4A_PATH_SEGMENT_BYTES + 1);
		expect(() =>
			parseV4aPatch(`*** Begin Patch\n*** Add File: ${oversizedSegment}\n+value\n*** End Patch`),
		).toThrow(`path segment exceeds ${MAX_V4A_PATH_SEGMENT_BYTES} byte limit`);
		const oversizedPath = `a/${"b".repeat(MAX_V4A_PATH_BYTES)}`;
		expect(() =>
			parseV4aPatch(`*** Begin Patch\n*** Add File: ${oversizedPath}\n+value\n*** End Patch`),
		).toThrow(`path exceeds ${MAX_V4A_PATH_BYTES} byte limit`);
	});

	test("reports original source lines for actionable V4A syntax errors", () => {
		expect(() =>
			parseV4aPatch(
				"```patch\n*** Begin Patch\n*** Add File: value.txt\ninvalid\n*** End Patch\n```",
			),
		).toThrow("Add content lines must begin with + at line 4");
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

describe("V4A prefix preview", () => {
	const complete =
		"*** Begin Patch\n" +
		"*** Add File: new.txt\n+one\n+two\n" +
		"*** Update File: old.txt\n*** Move to: moved.txt\n-old\n+new\n" +
		"*** Delete File: gone.txt\n" +
		"*** End Patch";

	test("exposes only complete Add File headers", () => {
		expect(previewV4aPatchPrefix("*** Begin Patch\n*** Add File: stream.txt\n", false)).toEqual([
			{ kind: "add", path: "stream.txt", addedLines: 0, removedLines: 0 },
		]);
		expect(previewV4aPatchPrefix("*** Begin Patch\n*** Add File: stream.tx", false)).toEqual([]);
	});

	test("counts completed add and update lines without inventing delete size", () => {
		expect(
			previewV4aPatchPrefix(
				"*** Begin Patch\n*** Add File: new.txt\n+one\n*** Update File: old.txt\n-old\n+new\n*** Delete File: gone.txt\n",
				false,
			),
		).toEqual([
			{ kind: "add", path: "new.txt", addedLines: 1, removedLines: 0 },
			{ kind: "update", path: "old.txt", addedLines: 1, removedLines: 1 },
			{ kind: "delete", path: "gone.txt", addedLines: 0, removedLines: 0 },
		]);
	});

	test("finalizes an unterminated last line only when arguments are complete", () => {
		const prefix = "*** Begin Patch\n*** Add File: stream.txt\n+one";
		expect(previewV4aPatchPrefix(prefix, false)).toEqual([
			{ kind: "add", path: "stream.txt", addedLines: 0, removedLines: 0 },
		]);
		expect(previewV4aPatchPrefix(prefix, true)).toEqual([
			{ kind: "add", path: "stream.txt", addedLines: 1, removedLines: 0 },
		]);
	});

	test("keeps confirmed rows when a later suffix is malformed", () => {
		expect(
			previewV4aPatchPrefix(
				"*** Begin Patch\n*** Add File: keep.txt\n+ok\n*** Nope\n*** Add File: later.txt\n+nope\n",
				false,
			),
		).toEqual([{ kind: "add", path: "keep.txt", addedLines: 1, removedLines: 0 }]);
	});

	test("never throws on partial or malformed prefixes", () => {
		const prefixes = [
			"",
			"***",
			"*** Begin Patch\n*** Add File: ",
			complete.slice(0, 17),
			"not a patch",
		];
		for (const prefix of prefixes) {
			expect(() => previewV4aPatchPrefix(prefix, false)).not.toThrow();
			expect(() => previewV4aPatchPrefix(prefix, true)).not.toThrow();
		}
	});

	test("matches the strict parser on a complete add/update/delete/move patch", () => {
		expect(parseV4aPatch(complete).operations.map((operation) => operation.kind)).toEqual([
			"add",
			"update",
			"delete",
		]);
		expect(previewV4aPatchPrefix(complete, true)).toEqual([
			{ kind: "add", path: "new.txt", addedLines: 2, removedLines: 0 },
			{ kind: "update", path: "moved.txt", addedLines: 1, removedLines: 1 },
			{ kind: "delete", path: "gone.txt", addedLines: 0, removedLines: 0 },
		]);
	});

	test("counts files across extra Begin/End markers", () => {
		const concatenated =
			"*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch\n*** Begin Patch\n*** Add File: b.txt\n+b\n*** End Patch";
		expect(previewV4aPatchFileCount(concatenated)).toBe(2);
		expect(previewV4aPatchPrefix(concatenated, true).map((operation) => operation.path)).toEqual([
			"a.txt",
			"b.txt",
		]);
	});

	test("stops expanding once the patch byte limit is reached", () => {
		const huge = `${"x".repeat(MAX_V4A_PATCH_BYTES + 1)}\n*** Add File: late.txt\n+nope\n`;
		expect(previewV4aPatchPrefix(huge, true)).toEqual([]);
	});

	test("grows monotonically across every character of a complete patch", () => {
		let previous = 0;
		for (let index = 0; index <= complete.length; index += 1) {
			const operations = previewV4aPatchPrefix(complete.slice(0, index), false);
			expect(operations.length).toBeGreaterThanOrEqual(previous);
			previous = operations.length;
		}
	});

	test("incremental cursor matches a full rescan after each appended chunk", () => {
		const cursor = createV4aPreviewCursor();
		for (let index = 0; index <= complete.length; index += 1) {
			const prefix = complete.slice(0, index);
			expect(previewV4aPatchPrefix(prefix, false, cursor)).toEqual(
				previewV4aPatchPrefix(prefix, false),
			);
		}
	});

	test("rewritten prefixes discard the cursor and rebuild", () => {
		const cursor = createV4aPreviewCursor();
		previewV4aPatchPrefix("*** Begin Patch\n*** Add File: old.txt\n+one\n", false, cursor);
		expect(
			previewV4aPatchPrefix("*** Begin Patch\n*** Add File: new.txt\n+two\n", false, cursor),
		).toEqual([{ kind: "add", path: "new.txt", addedLines: 1, removedLines: 0 }]);
	});

	test("file count uses completed headers and move targets", () => {
		expect(previewV4aPatchFileCount("*** Begin Patch\n*** Add File: a.txt")).toBe(0);
		expect(previewV4aPatchFileCount("*** Begin Patch\n*** Add File: a.txt\n")).toBe(1);
		expect(
			previewV4aPatchFileCount(
				"*** Begin Patch\n*** Update File: old.txt\n*** Move to: moved.txt\n*** Add File: extra.txt\n",
			),
		).toBe(2);
	});

	test("file count reuses a preview cursor instead of rescanning payload", () => {
		const cursor = createV4aPreviewCursor();
		const header = "*** Begin Patch\n*** Add File: a.txt\n";
		const payload = `${header}${"+line\n".repeat(40)}`;
		expect(previewV4aPatchFileCount(header, cursor)).toBe(1);
		const consumedAfterHeader = cursor.consumed.length;
		expect(previewV4aPatchFileCount(payload, cursor)).toBe(1);
		expect(cursor.consumed.length).toBeGreaterThan(consumedAfterHeader);
		expect(cursor.consumed).toBe(payload);
	});
});
