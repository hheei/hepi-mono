import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyPatchThroughCoordinator,
	warmApplyPatchCoordinator,
} from "../src/apply-patch/index.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-apply-patch-coordinator-"));
	temporaryPaths.push(path);
	return path;
}

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

test("prewarms a workspace coordinator before its first patch", async (): Promise<void> => {
	const root = await temporaryDirectory();
	await warmApplyPatchCoordinator(root);

	const result = await applyPatchThroughCoordinator({
		workspaceRoot: root,
		patch: "*** Begin Patch\n*** Add File: warmed.txt\n+warmed\n*** End Patch",
	});

	expect(result.changedPaths).toEqual(["warmed.txt"]);
	expect(await readFile(join(root, "warmed.txt"), "utf8")).toBe("warmed\n");
});

test("starts one local coordinator and applies its V4A request", async (): Promise<void> => {
	const root = await temporaryDirectory();
	const result = await applyPatchThroughCoordinator({
		workspaceRoot: root,
		patch: "*** Begin Patch\n*** Add File: created.txt\n+created\n*** End Patch",
	});

	expect(result).toMatchObject({
		changedPaths: ["created.txt"],
		operationCount: 1,
		exactUpdateCount: 0,
		fuzzyUpdateCount: 0,
	});
	expect(await readFile(join(root, "created.txt"), "utf8")).toBe("created\n");
});

test("reports parsed operations before workspace validation and apply", async (): Promise<void> => {
	const root = await temporaryDirectory();
	const progress: { readonly files: number; readonly operations: readonly unknown[] }[] = [];
	await applyPatchThroughCoordinator({
		workspaceRoot: root,
		patch:
			"*** Begin Patch\n" +
			"*** Add File: first.txt\n+one\n" +
			"*** Add File: second.txt\n+two\n" +
			"*** End Patch",
		onProgress: (update) => progress.push(update),
	});
	expect(progress[0]).toMatchObject({
		files: 1,
		addedLines: 0,
		removedLines: 0,
		operations: [{ kind: "add", path: "first.txt", status: "pending" }],
	});
	expect(progress[1]).toMatchObject({
		files: 2,
		addedLines: 0,
		removedLines: 0,
		operations: [
			{ kind: "add", path: "first.txt", status: "pending" },
			{ kind: "add", path: "second.txt", status: "pending" },
		],
	});
});

test("returns accepted and rejected operations independently", async (): Promise<void> => {
	const root = await temporaryDirectory();
	await writeFile(join(root, "existing.txt"), "existing\n", "utf8");

	const result = await applyPatchThroughCoordinator({
		workspaceRoot: root,
		patch:
			"*** Begin Patch\n" +
			"*** Add File: created.txt\n+created\n" +
			"*** Add File: existing.txt\n+replacement\n" +
			"*** End Patch",
	});

	expect(result.changedPaths).toEqual(["created.txt"]);
	expect(result.rejected).toMatchObject([{ paths: ["existing.txt"] }]);
	expect(await readFile(join(root, "created.txt"), "utf8")).toBe("created\n");
	expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("existing\n");
});
