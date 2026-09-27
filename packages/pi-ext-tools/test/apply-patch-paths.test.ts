import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isPatchPathOutsideWorkspace, resolvePatchPath } from "../src/apply-patch/paths.js";
import { temporaryDirectories } from "./fixtures/tmp-dir.js";

const temporaryDirectory = temporaryDirectories("hepi-apply-patch-paths-");

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
