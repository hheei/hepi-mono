import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, renameSync, watch, writeFileSync } from "node:fs";
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
import { applyPatchInWorkspace } from "../src/apply-patch/executor.js";
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

describe("staged apply-patch executor", () => {
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
	test("rejects an external mode change before commit", async () => {
		const root = await temporaryDirectory();
		const path = join(root, "script.sh");
		await writeFile(path, "before\n", "utf8");
		await chmod(path, 0o755);
		let changedMode = false;

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch: "*** Begin Patch\n*** Update File: script.sh\n-before\n+after\n*** End Patch",
			onProgress: () => {
				if (changedMode) return;
				changedMode = true;
				chmodSync(path, 0o600);
			},
		});

		expect(result.changedPaths).toEqual([]);
		expect(result.rejected).toMatchObject([{ paths: ["script.sh"] }]);
		expect((await stat(path)).mode & 0o7777).toBe(0o600);
		expect(await load(root, "script.sh")).toBe("before\n");
	});

	test("accepts the coordinator's pre-parsed patch without reparsing", async () => {
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
	test("rejects a symlinked commit parent without writing outside the workspace", async () => {
		const root = await temporaryDirectory();
		const outside = await temporaryDirectory();
		await symlink(outside, join(root, "nested"));

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch: "*** Begin Patch\n*** Add File: nested/escaped.txt\n+outside\n*** End Patch",
		});

		expect(result.rejected).toHaveLength(1);
		await expect(readFile(join(outside, "escaped.txt"), "utf8")).rejects.toThrow();
	});
	test("reports indeterminate when the temporary source entry is replaced", async () => {
		const root = await temporaryDirectory();
		const outside = join(root, "outside.txt");
		await writeFile(outside, "outside\n", "utf8");
		let replaced = false;
		let replacement: Promise<void> | undefined;
		const watcher = watch(root, (_event, filename) => {
			const name = String(filename ?? "");
			if (replacement !== undefined || !name.startsWith(".hepi-apply-patch-")) return;
			const temporary = join(root, name);
			replacement = (async () => {
				for (let attempt = 0; attempt < 20; attempt += 1)
					try {
						await rm(temporary, { force: true });
						await symlink(outside, temporary);
						replaced = true;
						return;
					} catch {
						await Bun.sleep(0);
					}
				throw new Error("Could not replace apply_patch temporary entry");
			})();
		});

		try {
			await expect(
				applyPatchInWorkspace({
					workspaceRoot: root,
					policy: noFuzzy,
					patch: `*** Begin Patch\n*** Add File: value.txt\n+${"x".repeat(900_000)}\n*** End Patch`,
				}),
			).rejects.toThrow("workspace state indeterminate");
		} finally {
			watcher.close();
		}

		expect(replacement).toBeDefined();
		await replacement;
		expect(replaced).toBe(true);
		expect(await load(root, "outside.txt")).toBe("outside\n");
		expect((await lstat(join(root, "value.txt"))).isSymbolicLink()).toBe(true);
	});

	test("rolls back the fixed workspace inode when its pathname is replaced", async () => {
		const root = await temporaryDirectory();
		const original = `${root}-original`;
		let replaced = false;

		await expect(
			applyPatchInWorkspace({
				workspaceRoot: root,
				policy: noFuzzy,
				patch:
					"*** Begin Patch\n" +
					"*** Add File: first.txt\n+first\n" +
					"*** Add File: second.txt\n+second\n" +
					"*** End Patch",
				onProgress: (progress) => {
					if (replaced || progress.stage !== "committed") return;
					replaced = true;
					renameSync(root, original);
					mkdirSync(root);
				},
			}),
		).rejects.toThrow("commit rolled back");

		expect(replaced).toBe(true);
		await expect(readFile(join(original, "first.txt"), "utf8")).rejects.toThrow();
		await expect(readFile(join(original, "second.txt"), "utf8")).rejects.toThrow();
		await expect(readFile(join(root, "first.txt"), "utf8")).rejects.toThrow();
		await expect(readFile(join(root, "second.txt"), "utf8")).rejects.toThrow();
	});

	test("applies add, update, delete, and move through staging", async () => {
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

	test("commits successful hunks when another hunk in the same update fails", async () => {
		const root = await temporaryDirectory();
		await save(root, "value.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
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

	test("applies ordered delete and add on the same path", async () => {
		const root = await temporaryDirectory();
		await save(root, "value.txt", "before\n");

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n" +
				"*** Delete File: value.txt\n" +
				"*** Add File: value.txt\n+after\n" +
				"*** End Patch",
		});

		expect(result.changedPaths).toEqual(["value.txt"]);
		expect(result.rejected).toEqual([]);
		expect(await load(root, "value.txt")).toBe("after\n");
	});

	test("applies ordered add and delete on the same path", async () => {
		const root = await temporaryDirectory();

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n" +
				"*** Add File: value.txt\n+temporary\n" +
				"*** Delete File: value.txt\n" +
				"*** End Patch",
		});

		expect(result.changedPaths).toEqual(["value.txt"]);
		expect(result.rejected).toEqual([]);
		await expect(readFile(join(root, "value.txt"), "utf8")).rejects.toThrow();
	});

	test("rejects stale operation without blocking valid operations", async () => {
		const root = await temporaryDirectory();
		await save(root, "first.txt", "first\n");
		await save(root, "second.txt", "second\n");
		const controller = new AbortController();
		let checks = 0;
		Object.defineProperty(controller.signal, "throwIfAborted", {
			value: () => {
				checks += 1;
				if (checks === 2) writeFileSync(join(root, "second.txt"), "stale\n", "utf8");
			},
		});

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			signal: controller.signal,
			patch:
				"*** Begin Patch\n" +
				"*** Update File: first.txt\n-first\n+changed\n" +
				"*** Update File: second.txt\n-second\n+changed\n" +
				"*** End Patch",
		});
		expect(result.changedPaths).toEqual(["first.txt"]);
		expect(result.rejected).toMatchObject([{ paths: ["second.txt"] }]);
		expect(await load(root, "first.txt")).toBe("changed\n");
		expect(await load(root, "second.txt")).toBe("stale\n");
	});

	test("rejects a deleted parent during a later commit", async () => {
		const root = await temporaryDirectory();
		await save(root, "nested/first.txt", "first\n");
		await save(root, "nested/second.txt", "second\n");
		let removed = false;

		await expect(
			applyPatchInWorkspace({
				workspaceRoot: root,
				policy: noFuzzy,
				patch:
					"*** Begin Patch\n" +
					"*** Update File: nested/first.txt\n-first\n+changed\n" +
					"*** Update File: nested/second.txt\n-second\n+changed\n" +
					"*** End Patch",
				onProgress: (progress) => {
					if (!removed && progress.stage === "committed") {
						removed = true;
						void rm(join(root, "nested"), { recursive: true, force: true });
					}
				},
			}),
		).rejects.toThrow("workspace state indeterminate");
		expect(removed).toBe(true);
	});

	test("rolls back every path when cancellation interrupts commit", async (): Promise<void> => {
		const root = await temporaryDirectory();
		const controller = new AbortController();
		const stages: ApplyPatchProgress[] = [];
		await expect(
			applyPatchInWorkspace({
				workspaceRoot: root,
				policy: noFuzzy,
				signal: controller.signal,
				patch:
					"*** Begin Patch\n" +
					"*** Add File: nested/first.txt\n+first\n" +
					"*** Add File: nested/second.txt\n+second\n" +
					"*** End Patch",
				onProgress: (progress) => {
					stages.push(progress);
					if (
						progress.stage === "committed" &&
						progress.operations.some((operation) => operation.status === "applied")
					)
						controller.abort(new Error("cancelled during commit"));
				},
			}),
		).rejects.toThrow("commit rolled back");
		const rolledBack = stages.at(-1);
		if (rolledBack === undefined) throw new Error("Expected rollback progress");
		expect(rolledBack.stage).toBe("rolled_back");
		expect(rolledBack.operations[0]).toMatchObject({
			status: "rejected",
			addedLines: 0,
			removedLines: 0,
		});
		expect(rolledBack.operations[0]).not.toHaveProperty("appliedHunks");
		expect(rolledBack.operations[0]).not.toHaveProperty("totalHunks");
		expect(rolledBack.operations[0]).not.toHaveProperty("partialReason");
		expect(rolledBack.operations[1]).toMatchObject({ status: "pending" });
		await expect(readFile(join(root, "nested", "first.txt"), "utf8")).rejects.toThrow();
		await expect(readFile(join(root, "nested", "second.txt"), "utf8")).rejects.toThrow();
		await expect(stat(join(root, "nested"))).rejects.toThrow();
	});

	test("aborts before staging without changing workspace", async () => {
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
});
