import { describe, expect, test } from "vitest";
import { prepareJsDiffUpdate } from "../src/apply-patch/jsdiff-matching.js";
import type { PreparedPatchUpdate } from "../src/apply-patch/outcome.js";
import { compileV4aUpdateToUnifiedDiff, parseV4aPatch } from "../src/apply-patch/parser.js";

function prepare(before: string, body: string, fuzzFactor = 0): PreparedPatchUpdate {
	const operation = parseV4aPatch(
		`*** Begin Patch\n*** Update File: value.txt\n${body}\n*** End Patch`,
	).operations[0];
	if (operation?.kind !== "update") throw new Error("expected update fixture");
	return prepareJsDiffUpdate({
		before: new TextEncoder().encode(before),
		hunks: operation.hunks.map((hunk) => ({
			hunk,
			unifiedDiff: compileV4aUpdateToUnifiedDiff({ ...operation, hunks: [hunk] }),
		})),
		fuzzFactor,
		snapshotPath: operation.path,
	});
}

describe("apply-patch jsdiff matching", () => {
	test.each([
		{
			name: "inserts an unnumbered addition at the start",
			before: "keep-a\nkeep-b\n",
			body: "+inserted\n keep-a",
			after: "inserted\nkeep-a\nkeep-b\n",
		},
		{
			name: "disambiguates duplicate context with a sequential anchor",
			before: "scope-a\ntarget\nscope-b\ntarget\n",
			body: "@@ scope-b\n-target\n+changed",
			after: "scope-a\ntarget\nscope-b\nchanged\n",
		},
		{
			name: "tolerates trailing whitespace differences",
			before: "function hello() {\n  const x = 10;  \n  return x;  \n}\n",
			body: " function hello() {\n-  const x = 10;\n+  const x = 20;\n   return x;\n }",
			after: "function hello() {\n  const x = 20;\n  return x;  \n}\n",
		},
		{
			name: "tolerates unicode punctuation and quotes",
			before: "title: ‘Hello World’\nrange: 10–20\n",
			body: "-title: 'Hello World'\n+title: 'Hello Pi'\n range: 10-20",
			after: "title: 'Hello Pi'\nrange: 10–20\n",
		},
		{
			name: "retains baseline indentation despite drift",
			before: "class Worker:\n    def run(self):\n        val = 1\n        return val\n",
			body: "  def run(self):\n-    val = 1\n+    val = 2\n   return val",
			after: "class Worker:\n    def run(self):\n        val = 2\n        return val\n",
		},
		{
			name: "trims blank context that overshoots EOF",
			before: "const a = 1;\nconst b = 2;\n",
			body: " const b = 2;\n \n+const c = 3;",
			after: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
		},
		{
			name: "appends at EOF anchor",
			before: '{\n  "key": "value"\n}\n',
			body: "@@ EOF\n+// end of configuration",
			after: '{\n  "key": "value"\n}\n// end of configuration\n',
		},
		{
			name: "appends when line anchor exceeds EOF",
			before: '{\n  "key": "value"\n}\n// end of configuration\n',
			body: "@@ line 999\n+// another line",
			after: '{\n  "key": "value"\n}\n// end of configuration\n// another line\n',
		},
		{
			name: "accepts git hunk headers with line numbers",
			before: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
			body: "@@ -2,2 +2,3 @@\n const b = 2;\n+const b_new = 2.5;\n const c = 3;",
			after: "const a = 1;\nconst b = 2;\nconst b_new = 2.5;\nconst c = 3;\n",
		},
		{
			name: "uses trailing text in git hunk anchors",
			before: "const a = 1;\nconst b = 2;\nconst b_new = 2.5;\nconst c = 3;\n",
			body: "@@ -2,2 +2,3 @@ const a = 1;\n const b = 2;\n+const b_more = 2.8;\n const b_new = 2.5;",
			after: "const a = 1;\nconst b = 2;\nconst b_more = 2.8;\nconst b_new = 2.5;\nconst c = 3;\n",
		},
		{
			name: "adjusts relative indentation when dedenting",
			before: "def run():\n    if True:\n        x = 1\n",
			body: "  if True:\n-   x = 1\n+   x = 2\n+ return x",
			after: "def run():\n    if True:\n        x = 2\n    return x\n",
		},
		{
			name: "replaces at EOF anchor",
			before: "first\nsecond\nlast\n",
			body: "@@ EOF\n-last\n+final",
			after: "first\nsecond\nfinal\n",
		},
		{
			name: "uses an in-bounds line anchor without appending at EOF",
			before: "line one\n",
			body: "@@ 1\n-line one\n+line replaced",
			after: "line replaced\n",
		},
		{
			name: "disambiguates repeated context at EOF",
			before: "same\nsame\n",
			body: "-same\n+final\n*** End of File",
			after: "same\nfinal\n",
		},
	])("$name", ({ before, body, after }) => {
		const result = prepare(before, body);
		expect(result.rejected).toEqual([]);
		expect(result.outcomes).toHaveLength(1);
		expect(new TextDecoder().decode(result.after)).toBe(after);
	});

	test("replaces a unique unnumbered line far from the start", () => {
		const lines = Array.from({ length: 100 }, (_value, index) => `line-${index + 1}`);
		lines[79] = "unique-target";
		const result = prepare(`${lines.join("\n")}\n`, "-unique-target\n+replaced-target");
		expect(result.rejected).toEqual([]);
		expect(result.outcomes).toMatchObject([
			{ kind: "applied", match: "exact", hunkIndex: 1, startLine: 80 },
		]);
		lines[79] = "replaced-target";
		expect(new TextDecoder().decode(result.after)).toBe(`${lines.join("\n")}\n`);
	});

	test.each([
		["duplicate exact context", "same\nkeep\nsame\nkeep\n", " same\n-keep\n+changed", [1, 3]],
		[
			"duplicate context after anchor",
			"scope\ntarget\ntarget\n",
			"@@ scope\n-target\n+changed",
			[2, 3],
		],
	] as const)("rejects %s with one-based candidates", (_name, before, body, candidates) => {
		const result = prepare(before, body);
		expect(result.outcomes).toEqual([]);
		expect(result.rejected).toEqual([
			{ kind: "ambiguous_exact", hunkIndex: 1, candidateStartLines: candidates },
		]);
		expect(new TextDecoder().decode(result.after)).toBe(before);
	});

	test("numbers a rejected hunk against the file the operation leaves behind", () => {
		const lines = Array.from({ length: 20 }, (_value, index) => `line ${index + 1}`);
		lines[9] = "dup";
		lines[10] = "X";
		lines[14] = "dup";
		lines[15] = "X";
		// The first hunk is ambiguous; the second adds three lines above it. Candidates taken before
		// that shift would name lines 10 and 15 of a file the model never sees.
		const result = prepare(
			`${lines.join("\n")}\n`,
			"@@\n dup\n-X\n+changed\n@@\n line 1\n+A\n+B\n+C",
		);
		expect(result.rejected).toEqual([
			{ kind: "ambiguous_exact", hunkIndex: 1, candidateStartLines: [13, 18] },
		]);
		const after = new TextDecoder().decode(result.after).split("\n");
		expect(
			after.map((text, index) => [index + 1, text]).filter(([, text]) => text === "dup"),
		).toEqual([
			[13, "dup"],
			[18, "dup"],
		]);
	});

	test.each([
		{
			name: "similar context",
			before: "line one\n    target code\nline three\n",
			body: "-  target code\n-line mismatch\n+line replaced",
			hint: "found similar line with different indentation/whitespace at line 2",
		},
		{
			name: "context exceeding file length",
			before: "first line\nsecond line\n",
			body: " first line\n second line\n third line\n fourth line\n+fifth line",
			hint: "context exceeds file length (file has 2 lines",
		},
	])("reports actionable hint for $name", ({ before, body, hint }) => {
		const result = prepare(before, body);
		expect(result.outcomes).toEqual([]);
		expect(result.rejected).toEqual([
			{ kind: "context_not_found", hunkIndex: 1, hint: expect.stringContaining(hint) },
		]);
		expect(new TextDecoder().decode(result.after)).toBe(before);
	});

	test.each([
		["alpha\nbeta", "-beta\n+BETA", "alpha\nBETA"],
		["alpha", " alpha\n+beta", "alpha\nbeta"],
		["alpha", "+beta\n*** End of File", "alpha\nbeta"],
		["scope", "@@ scope\n+beta", "scope\nbeta"],
		["alpha\nbeta", "-beta", "alpha"],
		["head\nold\nlast\n", "-old\n+NEW\n last\n*** End of File", "head\nNEW\nlast\n"],
		["\uFEFFhead\nold\n", "-old\n+NEW", "\uFEFFhead\nNEW\n"],
		["same\r\nsame\n", "-same\n same\n+new", "same\nnew\n"],
		[
			"alpha\r\nbeta\ngamma\r\n",
			" alpha\n+inserted\n beta\n gamma",
			"alpha\r\ninserted\nbeta\ngamma\r\n",
		],
	])("preserves source bytes: %j with %j", (before, body, after) => {
		const result = prepare(before, body);
		expect(result.rejected).toEqual([]);
		expect(result.after).toEqual(new TextEncoder().encode(after));
	});

	test("reports fuzzy matching for non-exact tiers", () => {
		const result = prepare("  hello world\n", "-hello world\n+hello universe");
		expect(result.rejected).toEqual([]);
		expect(result.outcomes[0]?.match).toBe("fuzzy");
	});

	test("does not accept mismatched removed text with fuzzy enabled", () => {
		const before = "header\nscope\nconst value = 10;\n";
		const result = prepare(before, "@@ scope\n-const value = 20;\n+changed", 2);
		expect(result.outcomes).toEqual([]);
		expect(result.rejected).toMatchObject([{ kind: "context_not_found", hunkIndex: 1 }]);
		expect(new TextDecoder().decode(result.after)).toBe(before);
	});
});
