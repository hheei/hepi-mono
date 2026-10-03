import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { applyPatchInWorkspace } from "../src/apply-patch/executor.js";
import { runJsDiffUpdate } from "../src/apply-patch/jsdiff.js";
import { acquireMutationLock } from "../src/apply-patch/lock.js";
import { parseV4aPatch, type V4aUpdateOperation } from "../src/apply-patch/parser.js";
import { DEFAULT_APPLY_PATCH_POLICY } from "../src/apply-patch/policy.js";
import { temporaryDirectories } from "./fixtures/tmp-dir.js";

const temporaryDirectory = temporaryDirectories("hepi-apply-patch-jsdiff-");

function updateOperation(patch: string): V4aUpdateOperation {
	const parsed = parseV4aPatch(patch).operations[0];
	if (parsed?.kind !== "update") throw new Error("expected update");
	return parsed;
}

describe("apply-patch jsdiff worker", () => {
	test("replaces a unique unnumbered line far from the start", async () => {
		const root = await temporaryDirectory();
		const lines = Array.from({ length: 100 }, (_value, index) => `line-${index + 1}`);
		lines[79] = "unique-target";
		await writeFile(join(root, "value.txt"), `${lines.join("\n")}\n`);
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: value.txt\n-unique-target\n+replaced-target\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(result.applied[0]?.outcomes).toMatchObject([
			{ kind: "applied", match: "exact", hunkIndex: 1 },
		]);
		const after = (await readFile(join(root, "value.txt"), "utf8")).split("\n");
		expect(after[79]).toBe("replaced-target");
		expect(after[0]).toBe("line-1");
	});

	test("inserts an unnumbered addition at the start of the file", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "value.txt"), "keep-a\nkeep-b\n");
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch: "*** Begin Patch\n*** Update File: value.txt\n+inserted\n keep-a\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(await readFile(join(root, "value.txt"), "utf8")).toBe("inserted\nkeep-a\nkeep-b\n");
	});

	test("rejects duplicate exact context without writing", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "value.txt"), "same\nkeep\nsame\nkeep\n");
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch: "*** Begin Patch\n*** Update File: value.txt\n same\n-keep\n+changed\n*** End Patch",
		});
		expect(result.changedPaths).toEqual([]);
		expect(result.rejected).toMatchObject([
			{ diagnostics: [{ kind: "ambiguous_exact", hunkIndex: 1, candidateStartLines: [1, 3] }] },
		]);
		expect(await readFile(join(root, "value.txt"), "utf8")).toBe("same\nkeep\nsame\nkeep\n");
	});

	test("disambiguates duplicate context with a unique sequential anchor", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "value.txt"), "scope-a\ntarget\nscope-b\ntarget\n");
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: value.txt\n@@ scope-b\n-target\n+changed\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(await readFile(join(root, "value.txt"), "utf8")).toBe(
			"scope-a\ntarget\nscope-b\nchanged\n",
		);
	});

	test("applies multiple hunks in one worker without rewriting the source file mid-flight", async () => {
		const before = new TextEncoder().encode("one\ntwo\nthree\nfour\n");
		const prepared = await runJsDiffUpdate({
			before,
			fuzzFactor: 0,
			operation: updateOperation(
				"*** Begin Patch\n*** Update File: value.txt\n@@\n-one\n+ONE\n@@\n-four\n+FOUR\n*** End Patch",
			),
		});
		expect(prepared.outcomes).toHaveLength(2);
		expect(prepared.rejected).toEqual([]);
		expect(new TextDecoder().decode(prepared.after)).toBe("ONE\ntwo\nthree\nFOUR\n");
		expect(new TextDecoder().decode(before)).toBe("one\ntwo\nthree\nfour\n");
	});

	test("rejects invalid UTF-8 without publishing", async () => {
		await expect(
			runJsDiffUpdate({
				before: Uint8Array.of(0xff, 0xfe, 0x00),
				fuzzFactor: 0,
				operation: updateOperation(
					"*** Begin Patch\n*** Update File: value.txt\n-a\n+b\n*** End Patch",
				),
			}),
		).rejects.toThrow("not valid UTF-8");
	});

	test("aborts before starting a worker", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			runJsDiffUpdate({
				before: new TextEncoder().encode("before\n"),
				fuzzFactor: 0,
				signal: controller.signal,
				operation: updateOperation(
					"*** Begin Patch\n*** Update File: value.txt\n-before\n+after\n*** End Patch",
				),
			}),
		).rejects.toThrow("cancelled");
	});

	test("terminates an in-flight worker and leaves the file unchanged", async () => {
		const root = await temporaryDirectory();
		// The worker only has to be busy when the abort lands; a couple of hundred lines are as
		// unusable as thousands, and they keep the file the worker scans small.
		const lines = Array.from({ length: 200 }, () => "repeated-context-line");
		lines[20] = "unique-old";
		await writeFile(join(root, "value.txt"), `${lines.join("\n")}\n`);
		const controller = new AbortController();
		const pending = applyPatchInWorkspace({
			workspaceRoot: root,
			policy: { fuzzFactor: 2 },
			signal: controller.signal,
			patch:
				"*** Begin Patch\n*** Update File: value.txt\n repeated-context-line\n-unique-old\n+unique-new\n repeated-context-line\n*** End Patch",
		});
		controller.abort(new Error("cancelled mid-worker"));
		await expect(pending).rejects.toThrow("cancelled mid-worker");
		expect(await readFile(join(root, "value.txt"), "utf8")).toContain("unique-old");
		const release = await acquireMutationLock(root);
		await release();
		const retry = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch: "*** Begin Patch\n*** Update File: value.txt\n-unique-old\n+unique-new\n*** End Patch",
		});
		expect(retry.rejected).toEqual([]);
		expect(await readFile(join(root, "value.txt"), "utf8")).toContain("unique-new");
	});

	test("tolerates trailing whitespace differences in context lines (Tier 2)", async () => {
		const root = await temporaryDirectory();
		// Target file has trailing spaces on lines 2 and 3
		await writeFile(
			join(root, "code.ts"),
			"function hello() {\n  const x = 10;  \n  return x;  \n}\n",
		);
		// Patch does NOT have trailing spaces on lines 2 and 3
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: code.ts\n function hello() {\n-  const x = 10;\n+  const x = 20;\n   return x;\n }\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(result.changedPaths).toEqual(["code.ts"]);
		expect(await readFile(join(root, "code.ts"), "utf8")).toBe(
			"function hello() {\n  const x = 20;\n  return x;  \n}\n",
		);
	});

	test("tolerates unicode punctuation and quote variants (Tier 2)", async () => {
		const root = await temporaryDirectory();
		// Target file has unicode smart quotes and en-dash
		await writeFile(join(root, "text.txt"), "title: ‘Hello World’\nrange: 10–20\n");
		// Patch uses standard ASCII quotes and hyphen
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: text.txt\n-title: 'Hello World'\n+title: 'Hello Hepi'\n range: 10-20\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(result.changedPaths).toEqual(["text.txt"]);
		expect(await readFile(join(root, "text.txt"), "utf8")).toBe(
			"title: 'Hello Hepi'\nrange: 10–20\n",
		);
	});

	test("tolerates indentation drift and retains surrounding baseline indentation (Tier 3)", async () => {
		const root = await temporaryDirectory();
		// Target file has 4 spaces indent
		await writeFile(
			join(root, "indent.py"),
			"class Worker:\n    def run(self):\n        val = 1\n        return val\n",
		);
		// Patch was generated with 2 spaces indent
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: indent.py\n  def run(self):\n-    val = 1\n+    val = 2\n   return val\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(result.changedPaths).toEqual(["indent.py"]);
		expect(await readFile(join(root, "indent.py"), "utf8")).toBe(
			"class Worker:\n    def run(self):\n        val = 2\n        return val\n",
		);
	});

	test("provides actionable diagnostic hint when context is not found near a similar line", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "sample.txt"), "line one\n    target code\nline three\n");
		// Patch expects a line that does not match but has a similar counterpart
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: sample.txt\n-  target code\n-line mismatch\n+line replaced\n*** End Patch",
		});
		expect(result.rejected).toHaveLength(1);
		const rejection = result.rejected[0];
		const diag = rejection?.diagnostics[0];
		expect(diag?.kind).toBe("context_not_found");
		if (diag?.kind === "context_not_found") {
			expect(diag.hint).toContain("found similar line with different indentation/whitespace");
			expect(diag.hint).toContain("line 2");
		}
	});

	test("tolerates trailing blank context lines that overshoot EOF and appends cleanly", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "app.ts"), "const a = 1;\nconst b = 2;\n");
		// Model thinks there is a blank line at the end of file and includes it in context
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: app.ts\n const b = 2;\n \n+const c = 3;\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(result.changedPaths).toEqual(["app.ts"]);
		expect(await readFile(join(root, "app.ts"), "utf8")).toBe(
			"const a = 1;\nconst b = 2;\nconst c = 3;\n",
		);
	});

	test("snaps to EOF when anchor specifies EOF or line number beyond EOF", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "config.json"), '{\n  "key": "value"\n}\n');
		// Model uses @@ EOF anchor
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: config.json\n@@ EOF\n+// end of configuration\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(result.changedPaths).toEqual(["config.json"]);
		expect(await readFile(join(root, "config.json"), "utf8")).toBe(
			'{\n  "key": "value"\n}\n// end of configuration\n',
		);

		// Also test line number beyond EOF
		const result2 = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: config.json\n@@ line 999\n+// another line\n*** End Patch",
		});
		expect(result2.rejected).toEqual([]);
		expect(await readFile(join(root, "config.json"), "utf8")).toBe(
			'{\n  "key": "value"\n}\n// end of configuration\n// another line\n',
		);
	});

	test("reports actionable hint when context length exceeds file line count", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "small.txt"), "first line\nsecond line\n");
		// Model provides 5 context lines on a 2-line file
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: small.txt\n first line\n second line\n third line\n fourth line\n+fifth line\n*** End Patch",
		});
		expect(result.rejected).toHaveLength(1);
		const diag = result.rejected[0]?.diagnostics[0];
		expect(diag?.kind).toBe("context_not_found");
		if (diag?.kind === "context_not_found") {
			expect(diag.hint).toContain("context exceeds file length");
			expect(diag.hint).toContain("file has 2 lines");
		}
	});

	test("handles git hunk headers with line numbers and trailing text in anchors", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "mod.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
		// LLM generates standard diff header in @@ anchor: @@ -2,2 +2,3 @@
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: mod.ts\n@@ -2,2 +2,3 @@\n const b = 2;\n+const b_new = 2.5;\n const c = 3;\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(result.changedPaths).toEqual(["mod.ts"]);
		expect(await readFile(join(root, "mod.ts"), "utf8")).toBe(
			"const a = 1;\nconst b = 2;\nconst b_new = 2.5;\nconst c = 3;\n",
		);

		// LLM generates header with trailing context/function heading: @@ -2,2 +2,3 @@ const a = 1;
		const result2 = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: mod.ts\n@@ -2,2 +2,3 @@ const a = 1;\n const b = 2;\n+const b_more = 2.8;\n const b_new = 2.5;\n*** End Patch",
		});
		expect(result2.rejected).toEqual([]);
		expect(await readFile(join(root, "mod.ts"), "utf8")).toBe(
			"const a = 1;\nconst b = 2;\nconst b_more = 2.8;\nconst b_new = 2.5;\nconst c = 3;\n",
		);
	});

	test("adjusts relative indentation when dedenting or unindenting", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "scope.py"), "def run():\n    if True:\n        x = 1\n");
		// In patch: if True has 2 spaces, x = 1 has 4 spaces, return x has 2 spaces (dedents back to if True level)
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: scope.py\n  if True:\n-   x = 1\n+   x = 2\n+ return x\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(await readFile(join(root, "scope.py"), "utf8")).toBe(
			"def run():\n    if True:\n        x = 2\n    return x\n",
		);
	});

	test("replaces at EOF when anchor specifies EOF with remove/add", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "tail.txt"), "first\nsecond\nlast\n");
		// Hunk targets EOF with replacement of last line
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch: "*** Begin Patch\n*** Update File: tail.txt\n@@ EOF\n-last\n+final\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(await readFile(join(root, "tail.txt"), "utf8")).toBe("first\nsecond\nfinal\n");
	});

	test("reports fuzzy match for non-exact tiers to maintain visibility", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "vis.txt"), "  hello world\n");
		// Trailing whitespace and indent tolerance (Tier 3)
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: vis.txt\n-hello world\n+hello universe\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(result.applied[0]?.outcomes[0]?.match).toBe("fuzzy");
	});

	test("respects valid line number anchor within bounds without treating it as EOF", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "single.txt"), "line one\n");
		// @@ 1 on a 1-line file should target line 1, not force EOF append
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: DEFAULT_APPLY_PATCH_POLICY,
			patch:
				"*** Begin Patch\n*** Update File: single.txt\n@@ 1\n-line one\n+line replaced\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(await readFile(join(root, "single.txt"), "utf8")).toBe("line replaced\n");
	});
});
