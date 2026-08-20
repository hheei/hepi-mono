import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePatchPath } from "../src/apply-patch/paths.js";

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

describe("apply_patch workspace paths", () => {
	test("accepts a relative non-symlink target", async (): Promise<void> => {
		const root = await temporaryDirectory();
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "value.ts"), "value\n");
		await expect(validatePatchPath(root, "src/value.ts")).resolves.toEqual({
			relativePath: "src/value.ts",
			absolutePath: join(root, "src", "value.ts"),
		});
	});

	test("rejects root escapes and Windows absolute paths", async (): Promise<void> => {
		const root = await temporaryDirectory();
		for (const path of ["../outside", "src/../outside", "/tmp/outside", "C:\\outside"]) {
			await expect(validatePatchPath(root, path)).rejects.toThrow("Patch path");
		}
	});

	test("accepts a lexically valid path even when a segment is a symlink", async (): Promise<void> => {
		const root = await temporaryDirectory();
		const outside = await temporaryDirectory();
		await symlink(outside, join(root, "linked"));
		await expect(validatePatchPath(root, "linked/value.ts")).resolves.toEqual({
			relativePath: "linked/value.ts",
			absolutePath: join(root, "linked", "value.ts"),
		});
	});
});
