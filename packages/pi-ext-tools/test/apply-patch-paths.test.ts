import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isPatchPathOutsideWorkspace, resolvePatchPath } from "../src/apply-patch/paths.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-apply-patch-paths-"));
	temporaryPaths.push(path);
	return path;
}

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("apply_patch paths", () => {
	test("resolves relative paths from the workspace", async (): Promise<void> => {
		const root = await temporaryDirectory();
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "value.ts"), "value\n");
		expect(resolvePatchPath(root, "src/value.ts")).toBe(join(root, "src", "value.ts"));
	});

	test("allows absolute and workspace-escaping paths", async (): Promise<void> => {
		const root = await temporaryDirectory();
		expect(resolvePatchPath(root, "../outside")).toBe(join(root, "..", "outside"));
		expect(resolvePatchPath(root, "/tmp/outside")).toBe("/tmp/outside");
		expect(isPatchPathOutsideWorkspace(root, "../outside")).toBe(true);
		expect(isPatchPathOutsideWorkspace(root, "/tmp/outside")).toBe(true);
	});

	test("does not follow symlinks when classifying workspace paths", async (): Promise<void> => {
		const root = await temporaryDirectory();
		const outside = await temporaryDirectory();
		await symlink(outside, join(root, "linked"));
		expect(isPatchPathOutsideWorkspace(root, "linked/value.ts")).toBe(false);
	});
});
