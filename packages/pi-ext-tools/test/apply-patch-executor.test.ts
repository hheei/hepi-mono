import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyPatchInWorkspace } from "../src/apply-patch/executor.js";
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
				error: "Patch update failed exactly and fuzzy is disabled: value.txt",
				diagnostics: [{ kind: "context_not_found", hunkIndex: 1 }],
			},
		]);
		expect(await load(root, "value.txt")).toBe("alpha\nchanged context\nomega\n");
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

	test("rejects path conflicts before touching the workspace", async () => {
		const root = await temporaryDirectory();
		await save(root, "value.txt", "before\n");

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			patch:
				"*** Begin Patch\n" +
				"*** Update File: value.txt\n-before\n+first\n" +
				"*** Update File: value.txt\n-before\n+second\n" +
				"*** End Patch",
		});
		expect(result.changedPaths).toEqual([]);
		expect(result.rejected).toMatchObject([
			{
				operationIndices: [0, 1],
				paths: ["value.txt"],
				error: "path touched more than once: value.txt",
			},
		]);
		expect(await load(root, "value.txt")).toBe("before\n");
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
