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
});
