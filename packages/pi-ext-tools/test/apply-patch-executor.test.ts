import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import { applyPatchInWorkspace } from "../src/apply-patch/executor.js";
import { APPLY_PATCH_MAX_FILE_SIZE } from "../src/apply-patch/fs.js";
import type { ApplyPatchProgress } from "../src/apply-patch/outcome.js";
import { parseV4aPatch } from "../src/apply-patch/parser.js";
import {
	DEFAULT_FUZZY_APPLY_PATCH_POLICY,
	type FuzzyApplyPatchPolicy,
} from "../src/apply-patch/policy.js";

const temporaryPaths: string[] = [];
const noFuzzy: FuzzyApplyPatchPolicy = {
	...DEFAULT_FUZZY_APPLY_PATCH_POLICY,
	minSimilarity: 0,
};
const fuzzy: FuzzyApplyPatchPolicy = {
	...DEFAULT_FUZZY_APPLY_PATCH_POLICY,
	minSimilarity: 0.5,
};

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-apply-patch-executor-"));
	temporaryPaths.push(path);
	return path;
}

async function save(root: string, relativePath: string, content: string): Promise<void> {
	const absolutePath = join(root, ...relativePath.split("/"));
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf8");
}

async function load(root: string, relativePath: string): Promise<string> {
	return await readFile(join(root, ...relativePath.split("/")), "utf8");
}

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("apply-patch executor", () => {
	test("preserves executable mode through an update", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "script.sh");
		await writeFile(path, "before\n", "utf8");
		await chmod(path, 0o755);

		await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch: "*** Begin Patch\n*** Update File: script.sh\n-before\n+after\n*** End Patch",
		});

		expect((await stat(path)).mode & 0o7777).toBe(0o755);
		expect(await load(root, "script.sh")).toBe("after\n");
	});

	test("accepts a pre-parsed patch without reparsing", async () => {
		const root = await temporaryDirectory();
		const patch = "*** Begin Patch\n*** Add File: parsed.txt\n+parsed\n*** End Patch";
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			patch,
			parsedPatch: parseV4aPatch(patch),
			policy: noFuzzy,
		});
		expect(result.changedPaths).toEqual(["parsed.txt"]);
		expect(await load(root, "parsed.txt")).toBe("parsed\n");
	});

	test("keeps snapshot coordinates in the per-hunk staging version", async () => {
		const root = await temporaryDirectory();
		await save(root, "value.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n" +
				"*** Update File: value.txt\n" +
				"@@\n-one\n+ONE\n+ONE-B\n" +
				"@@\n-nine\n+NINE\n" +
				"*** End Patch",
		});

		const snapshots = result.applied[0]?.snapshots;
		expect(snapshots).toHaveLength(2);
		expect(snapshots?.[1]).toMatchObject({ startLine: 7, afterStartLine: 7 });
		expect(await load(root, "value.txt")).toContain("NINE\n");
	});

	test("enforces sequential anchors and rejects missing or ambiguous constrained matches", async () => {
		const root = await temporaryDirectory();
		await save(
			root,
			"value.txt",
			"section one\ntarget one\nsection two\ntarget two\nsection three\ntarget three\n",
		);
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n*** Update File: value.txt\n@@ section two\n-target two\n+changed two\n@@ missing\n-target\n+nope\n@@ section three\n-target three\n+changed three\n*** End Patch",
		});
		expect(result.operations[0]).toMatchObject({ status: "partial", appliedHunks: 2 });
		expect(result.rejected).toMatchObject([
			{ diagnostics: [{ kind: "context_not_found", hunkIndex: 2 }] },
		]);
		expect(await load(root, "value.txt")).toBe(
			"section one\ntarget one\nsection two\nchanged two\nsection three\nchanged three\n",
		);

		await save(root, "ambiguous.txt", "scope\ntarget\ntarget\n");
		const ambiguous = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n*** Update File: ambiguous.txt\n@@ scope\n-target\n+changed\n*** End Patch",
		});
		expect(ambiguous.rejected).toMatchObject([
			{ diagnostics: [{ kind: "ambiguous_exact", hunkIndex: 1, candidateStartLines: [2, 3] }] },
		]);

		await save(root, "fuzzy.txt", "header\nscope\nconst value = 10;\n");
		const belowThreshold = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: { ...fuzzy, minSimilarity: 0.99 },
			patch:
				"*** Begin Patch\n*** Update File: fuzzy.txt\n@@ scope\n-const value = 20;\n+changed\n*** End Patch",
		});
		expect(belowThreshold.rejected).toMatchObject([
			{ diagnostics: [{ kind: "fuzzy_below_threshold", hunkIndex: 1, best: { startLine: 3 } }] },
		]);
		expect(await load(root, "fuzzy.txt")).toBe("header\nscope\nconst value = 10;\n");
	});

	test("uses EOF to disambiguate repeated exact context at the final line", async () => {
		const root = await temporaryDirectory();
		await save(root, "value.txt", "same\nsame\n");
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n*** Update File: value.txt\n@@\n-same\n+final\n*** End of File\n*** End Patch",
		});
		expect(result.rejected).toEqual([]);
		expect(await load(root, "value.txt")).toBe("same\nfinal\n");
	});

	test("preserves CRLF, final newline state, mixed untouched bytes, EOF, and pure moves", async () => {
		const root = await temporaryDirectory();
		await save(root, "mixed.txt", "unchanged\r\nold\nlast");
		await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n*** Update File: mixed.txt\n@@\n-old\n+new\n@@\n-last\n\\ No newline at end of file\n+final\n\\ No newline at end of file\n*** End of File\n*** End Patch",
		});
		expect(await readFile(join(root, "mixed.txt"))).toEqual(Buffer.from("unchanged\r\nnew\nfinal"));

		await save(root, "context.txt", "alpha\r\nbeta\ngamma\r\n");
		await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n*** Update File: context.txt\n@@\n alpha\n+inserted\n beta\n gamma\n*** End Patch",
		});
		expect(await readFile(join(root, "context.txt"))).toEqual(
			Buffer.from("alpha\r\ninserted\nbeta\ngamma\r\n"),
		);

		await save(root, "source.txt", "move\r\n");
		const moved = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n*** Update File: source.txt\n*** Move to: destination.txt\n*** End Patch",
		});
		expect(moved.operations[0]).toMatchObject({
			status: "applied",
			addedLines: 0,
			removedLines: 0,
		});
		expect(await readFile(join(root, "destination.txt"))).toEqual(Buffer.from("move\r\n"));
	});

	test("preserves EOF context, line boundaries, and source bytes together", async () => {
		const root = await temporaryDirectory();
		for (const [before, body, after] of [
			["alpha\nbeta", "-beta\n+BETA", "alpha\nBETA"],
			["alpha", " alpha\n+beta", "alpha\nbeta"],
			["alpha", "+beta\n*** End of File", "alpha\nbeta"],
			["scope", "@@ scope\n+beta", "scope\nbeta"],
			["alpha\nbeta", "-beta", "alpha"],
			["head\nold\nlast\n", "-old\n+NEW\n last\n*** End of File", "head\nNEW\nlast\n"],
			["\uFEFFhead\nold\n", "-old\n+NEW", "\uFEFFhead\nNEW\n"],
			["same\r\nsame\n", "-same\n same\n+new", "same\nnew\n"],
		] as const) {
			await save(root, "value.txt", before);
			const result = await applyPatchInWorkspace({
				workspaceRoot: root,
				policy: noFuzzy,
				patch: `*** Begin Patch\n*** Update File: value.txt\n@@\n${body}\n*** End Patch`,
			});
			expect(result.rejected, body).toEqual([]);
			expect(await readFile(join(root, "value.txt")), body).toEqual(Buffer.from(after));
		}
	});

	test("follows a parent symlink and writes through it", async () => {
		const root = await temporaryDirectory();
		const outside = await temporaryDirectory();
		await symlink(outside, join(root, "nested"));

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch: "*** Begin Patch\n*** Add File: nested/escaped.txt\n+outside\n*** End Patch",
		});

		expect(result.rejected).toEqual([]);
		expect(await load(outside, "escaped.txt")).toBe("outside\n");
	});

	test("updates an absolute path outside the workspace", async () => {
		const root = await temporaryDirectory();
		const outside = await temporaryDirectory();
		const path = join(outside, "absolute.txt");
		await writeFile(path, "before\n", "utf8");

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch: `*** Begin Patch\n*** Update File: ${path}\n-before\n+after\n*** End Patch`,
		});

		expect(result.rejected).toEqual([]);
		expect(result.changedPaths).toEqual([path]);
		expect(await readFile(path, "utf8")).toBe("after\n");
	});

	test("applies add, update, delete, and move", async () => {
		const root = await temporaryDirectory();
		await save(root, "src/update.txt", "one\ntwo\nthree\n");
		await save(root, "src/delete.txt", "remove\n");
		await save(root, "src/move.txt", "old name\n");
		const progress = [] as Parameters<
			NonNullable<Parameters<typeof applyPatchInWorkspace>[0]["onProgress"]>
		>[0][];

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n" +
				"*** Add File: src/add.txt\n+added\n" +
				"*** Update File: src/update.txt\n two\n+inserted\n" +
				"*** Delete File: src/delete.txt\n" +
				"*** Update File: src/move.txt\n*** Move to: src/moved.txt\n-old name\n+new name\n" +
				"*** End Patch",
			onProgress: (update) => progress.push(update),
		});

		expect(result).toMatchObject({
			changedPaths: [
				"src/add.txt",
				"src/update.txt",
				"src/delete.txt",
				"src/move.txt",
				"src/moved.txt",
			],
			operationCount: 4,
			exactUpdateCount: 2,
			fuzzyUpdateCount: 0,
			rejected: [],
			unconfirmed: [],
			notApplied: [],
		});
		expect(result.applied).toHaveLength(4);
		expect(progress.at(-1)?.operations).toEqual(result.operations);
		expect(
			progress.some((update) =>
				update.operations.some((operation) => operation.status === "pending"),
			),
		).toBe(true);
		expect(result.applied[1]).toMatchObject({
			paths: ["src/update.txt"],
			outcomes: [{ kind: "applied", hunkIndex: 1, match: "exact" }],
		});
		expect(result.applied[1]?.snapshots).toHaveLength(1);
		expect(await load(root, "src/add.txt")).toBe("added\n");
		expect(await load(root, "src/update.txt")).toBe("one\ntwo\ninserted\nthree\n");
		await expect(readFile(join(root, "src", "delete.txt"), "utf8")).rejects.toThrow();
		await expect(readFile(join(root, "src", "move.txt"), "utf8")).rejects.toThrow();
		expect(await load(root, "src/moved.txt")).toBe("new name\n");
	});

	test("windows add and delete snapshots instead of persisting the whole file", async () => {
		const root = await temporaryDirectory();
		const lines = Array.from({ length: 200 }, (_value, index) => `line-${index}`);
		await save(root, "gone.txt", `${lines.join("\n")}\n`);
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n" +
				`*** Add File: created.txt\n${lines.map((line) => `+${line}`).join("\n")}\n` +
				"*** Delete File: gone.txt\n" +
				"*** End Patch",
		});
		const created = result.applied.find((entry) => entry.kind === "add")?.snapshots[0];
		const deleted = result.applied.find((entry) => entry.kind === "delete")?.snapshots[0];
		expect(created?.after).toHaveLength(150);
		expect(created?.after.at(-1)).toBe("line-149");
		expect(created?.after).not.toContain("line-199");
		expect(deleted?.before).toHaveLength(150);
		expect(deleted?.before.at(-1)).toBe("line-149");
		expect(deleted?.before).not.toContain("line-199");
	});

	test("classifies near-context update as fuzzy when policy permits", async () => {
		const root = await temporaryDirectory();
		await save(root, "value.txt", "alpha\nchanged context\nomega\n");

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: fuzzy,
			patch:
				"*** Begin Patch\n" +
				"*** Update File: value.txt\n alpha\n expected context\n+inserted\n omega\n" +
				"*** End Patch",
		});

		expect(result.exactUpdateCount).toBe(0);
		expect(result.fuzzyUpdateCount).toBe(1);
		expect(await load(root, "value.txt")).toBe("alpha\nchanged context\ninserted\nomega\n");
	});

	test("fails disabled fuzzy update without changing workspace", async () => {
		const root = await temporaryDirectory();
		await save(root, "value.txt", "alpha\nchanged context\nomega\n");

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n" +
				"*** Update File: value.txt\n alpha\n expected context\n+inserted\n omega\n" +
				"*** End Patch",
		});
		expect(result.changedPaths).toEqual([]);
		expect(result.rejected).toMatchObject([
			{
				paths: ["value.txt"],
				error: "One or more update hunks failed",
				diagnostics: [{ kind: "context_not_found", hunkIndex: 1 }],
			},
		]);
		expect(await load(root, "value.txt")).toBe("alpha\nchanged context\nomega\n");
	});

	test("publishes successful hunks when another hunk in the same update fails", async () => {
		const root = await temporaryDirectory();
		await save(root, "value.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
		const progress: ApplyPatchProgress[] = [];

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			onProgress: (update) => progress.push(update),
			patch:
				"*** Begin Patch\n" +
				"*** Update File: value.txt\n" +
				"@@\n-one\n+ONE\n" +
				"@@\n-missing\n+MISS\n" +
				"@@\n-five\n+FIVE\n" +
				"*** End Patch",
		});

		expect(result.changedPaths).toEqual(["value.txt"]);
		expect(result.addedLines).toBe(2);
		expect(result.removedLines).toBe(2);
		expect(result.applied).toMatchObject([
			{
				paths: ["value.txt"],
				outcomes: [
					{ kind: "applied", hunkIndex: 1, match: "exact" },
					{ kind: "applied", hunkIndex: 3, match: "exact" },
				],
			},
		]);
		expect(result.rejected).toMatchObject([
			{
				operationIndices: [0],
				paths: ["value.txt"],
				diagnostics: [{ kind: "context_not_found", hunkIndex: 2 }],
			},
		]);
		expect(result.operations).toEqual([
			expect.objectContaining({
				path: "value.txt",
				status: "partial",
				appliedHunks: 2,
				totalHunks: 3,
				partialReason: "context not found",
				addedLines: 2,
				removedLines: 2,
			}),
		]);
		expect(await load(root, "value.txt")).toBe("ONE\ntwo\nthree\nfour\nFIVE\nsix\n");
		expect(progress.at(-1)).toMatchObject({
			stage: "done",
			addedLines: 2,
			removedLines: 2,
			operations: [
				{
					status: "partial",
					appliedHunks: 2,
					totalHunks: 3,
				},
			],
		});
	});

	test("moves a partially applied update after publishing successful hunks", async () => {
		const root = await temporaryDirectory();
		await save(root, "source.txt", "one\ntwo\nthree\n");

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n" +
				"*** Update File: source.txt\n" +
				"*** Move to: destination.txt\n" +
				"@@\n-one\n+ONE\n" +
				"@@\n-missing\n+MISS\n" +
				"*** End Patch",
		});

		expect(result.changedPaths).toEqual(["source.txt", "destination.txt"]);
		expect(result.operations).toEqual([
			expect.objectContaining({
				path: "destination.txt",
				status: "partial",
				appliedHunks: 1,
				totalHunks: 2,
			}),
		]);
		expect(await load(root, "destination.txt")).toBe("ONE\ntwo\nthree\n");
		await expect(readFile(join(root, "source.txt"), "utf8")).rejects.toThrow();
	});

	test("rejects ambiguous exact context with candidate lines", async () => {
		const root = await temporaryDirectory();
		await save(root, "value.txt", "same\nkeep\nsame\nkeep\n");

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n" +
				"*** Update File: value.txt\n same\n-keep\n+changed\n" +
				"*** End Patch",
		});
		expect(result.changedPaths).toEqual([]);
		expect(result.rejected).toMatchObject([
			{
				paths: ["value.txt"],
				diagnostics: [{ kind: "ambiguous_exact", hunkIndex: 1, candidateStartLines: [1, 3] }],
			},
		]);
		expect(await load(root, "value.txt")).toBe("same\nkeep\nsame\nkeep\n");
	});

	test("applies earlier operation when later operation fails", async () => {
		const root = await temporaryDirectory();
		await save(root, "first.txt", "first\n");
		await save(root, "second.txt", "second\n");

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n" +
				"*** Update File: first.txt\n-first\n+changed\n" +
				"*** Update File: second.txt\n-missing\n+changed\n" +
				"*** End Patch",
		});
		expect(result.changedPaths).toEqual(["first.txt"]);
		expect(result.rejected).toMatchObject([{ paths: ["second.txt"] }]);
		expect(await load(root, "first.txt")).toBe("changed\n");
		expect(await load(root, "second.txt")).toBe("second\n");
	});

	test("applies repeated updates to the same file in patch order", async () => {
		const root = await temporaryDirectory();
		await save(root, "value.txt", "before\n");

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n" +
				"*** Update File: value.txt\n-before\n+first\n" +
				"*** Update File: value.txt\n-first\n+second\n" +
				"*** End Patch",
		});
		expect(result.changedPaths).toEqual(["value.txt"]);
		expect(result.rejected).toEqual([]);
		expect(await load(root, "value.txt")).toBe("second\n");
	});

	test("applies ordered delete/add and add/delete on the same path", async () => {
		const cases = [
			{
				initial: "before\n",
				operations: "*** Delete File: value.txt\n*** Add File: value.txt\n+after\n",
				expected: "after\n",
			},
			{
				initial: undefined,
				operations: "*** Add File: value.txt\n+temporary\n*** Delete File: value.txt\n",
				expected: undefined,
			},
		];
		for (const { initial, operations, expected } of cases) {
			const root = await temporaryDirectory();
			if (initial !== undefined) await save(root, "value.txt", initial);
			const result = await applyPatchInWorkspace({
				workspaceRoot: root,
				policy: noFuzzy,
				patch: `*** Begin Patch\n${operations}*** End Patch`,
			});
			expect(result.changedPaths).toEqual(["value.txt"]);
			expect(result.rejected).toEqual([]);
			if (expected === undefined)
				await expect(readFile(join(root, "value.txt"), "utf8")).rejects.toThrow();
			else expect(await load(root, "value.txt")).toBe(expected);
		}
	});

	test("follows a leaf symlink on update and keeps the symlink", async () => {
		const root = await temporaryDirectory();
		const outside = await temporaryDirectory();
		await writeFile(join(outside, "target.txt"), "before\n", "utf8");
		await chmod(join(outside, "target.txt"), 0o755);
		await symlink(join(outside, "target.txt"), join(root, "link.txt"));

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch: "*** Begin Patch\n*** Update File: link.txt\n-before\n+after\n*** End Patch",
		});

		expect(result.rejected).toEqual([]);
		expect(await load(outside, "target.txt")).toBe("after\n");
		expect((await stat(join(outside, "target.txt"))).mode & 0o7777).toBe(0o755);
		expect((await lstat(join(root, "link.txt"))).isSymbolicLink()).toBe(true);
	});

	test("delete unlinks the symlink instead of its target", async () => {
		const root = await temporaryDirectory();
		const outside = await temporaryDirectory();
		await writeFile(join(outside, "target.txt"), "keep\n", "utf8");
		await symlink(join(outside, "target.txt"), join(root, "link.txt"));

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch: "*** Begin Patch\n*** Delete File: link.txt\n*** End Patch",
		});

		expect(result.changedPaths).toEqual(["link.txt"]);
		await expect(stat(join(root, "link.txt"))).rejects.toThrow();
		expect(await load(outside, "target.txt")).toBe("keep\n");
	});

	test("rejects add when the destination name is a symlink", async () => {
		const root = await temporaryDirectory();
		const outside = await temporaryDirectory();
		await symlink(outside, join(root, "exists.txt"));

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch: "*** Begin Patch\n*** Add File: exists.txt\n+nope\n*** End Patch",
		});

		expect(result.rejected).toMatchObject([{ paths: ["exists.txt"] }]);
		expect((await lstat(join(root, "exists.txt"))).isSymbolicLink()).toBe(true);
	});

	test("keeps confirmed paths when later operations are cancelled", async () => {
		const root = await temporaryDirectory();
		const controller = new AbortController();
		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			signal: controller.signal,
			patch:
				"*** Begin Patch\n" +
				"*** Add File: first.txt\n+first\n" +
				"*** Add File: second.txt\n+second\n" +
				"*** End Patch",
			onProgress: (progress) => {
				if (
					progress.stage === "publishing" &&
					progress.operations.some((operation) => operation.status === "applied")
				)
					controller.abort(new Error("cancelled after first"));
			},
		});
		expect(result.changedPaths).toEqual(["first.txt"]);
		expect(result.notApplied).toMatchObject([{ paths: ["second.txt"] }]);
		expect(await load(root, "first.txt")).toBe("first\n");
		await expect(readFile(join(root, "second.txt"), "utf8")).rejects.toThrow();
	});

	test("aborts before work without changing workspace", async () => {
		const root = await temporaryDirectory();
		await save(root, "value.txt", "before\n");
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));

		await expect(
			applyPatchInWorkspace({
				workspaceRoot: root,
				policy: fuzzy,
				signal: controller.signal,
				patch: "*** Begin Patch\n*** Update File: value.txt\n-before\n+after\n*** End Patch",
			}),
		).rejects.toThrow("cancelled");
		expect(await load(root, "value.txt")).toBe("before\n");
	});

	test("queues a second request until the workspace lock is released", async () => {
		const root = await temporaryDirectory();
		const controller = new AbortController();
		const { createLocalPatchFs } = await import("../src/apply-patch/fs.js");
		const local = createLocalPatchFs(root);
		const hung = {
			...local,
			async writeAtomic(
				path: string,
				data: Buffer,
				mode: number | undefined,
				signal?: AbortSignal,
			) {
				await new Promise<void>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
						once: true,
					});
					if (signal?.aborted) reject(signal.reason ?? new Error("aborted"));
				});
				await local.writeAtomic(path, data, mode, signal);
			},
		};
		const first = applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			fs: hung,
			patch: "*** Begin Patch\n*** Add File: first.txt\n+first\n*** End Patch",
			signal: controller.signal,
		});
		await sleep(30);
		const second = applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch: "*** Begin Patch\n*** Add File: second.txt\n+second\n*** End Patch",
		});
		controller.abort(new Error("cancelled"));
		await first.catch(() => undefined);
		const result = await second;
		expect(result.changedPaths).toEqual(["second.txt"]);
		expect(await load(root, "second.txt")).toBe("second\n");
	});

	test("rejects existing files larger than 32 MiB", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "huge.bin"), new Uint8Array(APPLY_PATCH_MAX_FILE_SIZE + 1));

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch: "*** Begin Patch\n*** Delete File: huge.bin\n*** End Patch",
		});
		expect(result.rejected[0]?.error).toContain("file_too_large");
		expect(await stat(join(root, "huge.bin"))).toBeDefined();
	});
});
