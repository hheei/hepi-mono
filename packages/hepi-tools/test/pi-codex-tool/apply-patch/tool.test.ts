import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createApplyPatchTool } from "../../../src/pi-codex-tool/tools/apply-patch/tool.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-apply-patch-"));
	temporaryPaths.push(path);
	return path;
}

describe("apply_patch tool", () => {
	test("serializes tool-call batches and reports partial mutations as errors", async () => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "first.txt"), "before\n", "utf8");
		await writeFile(join(cwd, "second.txt"), "actual\n", "utf8");
		const tool = createApplyPatchTool();
		const patch = `*** Begin Patch
*** Update File: first.txt
@@
-before
+after
*** Update File: second.txt
@@
-expected
+after
*** End Patch`;

		expect(tool.executionMode).toBe("sequential");
		await expect(
			tool.execute("partial", { input: patch }, undefined, undefined, {
				cwd,
			} as ExtensionContext),
		).rejects.toThrow("apply_patch partially failed");
		expect(await readFile(join(cwd, "first.txt"), "utf8")).toBe("after\n");
	});
});
