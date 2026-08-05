import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpatchRun } from "../src/native-bridge.js";

const temporaryPaths: string[] = [];

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-native-mpatch-"));
	temporaryPaths.push(path);
	return path;
}

describe("native mpatch", () => {
	test("applies vendored mpatch through N-API", async (): Promise<void> => {
		const root = await temporaryDirectory();
		const target = join(root, "value.txt");
		await writeFile(target, "before\n", "utf8");

		const run = new MpatchRun({
			cwd: root,
			unifiedDiff: "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+after\n",
			fuzzFactor: 0,
			dryRun: false,
		});
		const result = await run.run();

		expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
		expect(await readFile(target, "utf8")).toBe("after\n");
		expect(() => run.run()).toThrow("mpatch run has already completed");
	});

	test("observes cancellation before starting native work", async (): Promise<void> => {
		const root = await temporaryDirectory();
		const target = join(root, "value.txt");
		await writeFile(target, "before\n", "utf8");
		const run = new MpatchRun({
			cwd: root,
			unifiedDiff: "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+after\n",
			fuzzFactor: 0,
			dryRun: false,
		});

		await run.abort();
		await expect(run.run()).rejects.toThrow("mpatch aborted");
		expect(await readFile(target, "utf8")).toBe("before\n");
	});
});
