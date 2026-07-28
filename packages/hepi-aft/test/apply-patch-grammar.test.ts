import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createApplyPatchTool } from "../../hepi-tools/src/pi-codex-tool/tools/apply-patch/tool.js";
import { HepiAftRuntime } from "../src/aft/runtime.js";

const temporaryPaths: string[] = [];
let runtime: HepiAftRuntime | undefined;

beforeAll(async () => {
	runtime = new HepiAftRuntime();
	await runtime.start();
});

afterAll(async () => {
	await runtime?.dispose();
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-aft-patch-grammar-"));
	temporaryPaths.push(path);
	return path;
}

async function withFixture(
	files: Readonly<Record<string, string>>,
): Promise<{ readonly aft: string; readonly codex: string }> {
	const aft = await temporaryDirectory();
	const codex = await temporaryDirectory();
	for (const [path, content] of Object.entries(files)) {
		await Promise.all([writeFile(join(aft, path), content), writeFile(join(codex, path), content)]);
	}
	return { aft, codex };
}

async function applyAft(cwd: string, patchText: string): Promise<void> {
	const activeRuntime = runtime;
	if (activeRuntime === undefined) throw new Error("AFT runtime did not start");
	const response = await activeRuntime
		.getBridge(cwd)
		.toolCall("grammar", "apply_patch", { patchText });
	if (response.success === false)
		throw new Error(response.text || response.message || "AFT patch failed");
}

async function applyCodex(cwd: string, patchText: string): Promise<void> {
	const tool = createApplyPatchTool();
	await tool.execute("grammar", { input: patchText }, undefined, undefined, {
		cwd,
	} as ExtensionContext);
}

async function readBoth(
	paths: { readonly aft: string; readonly codex: string },
	file: string,
): Promise<readonly [string, string]> {
	return await Promise.all([
		readFile(join(paths.aft, file), "utf8"),
		readFile(join(paths.codex, file), "utf8"),
	]);
}

describe("AFT and Codex apply_patch grammar", () => {
	test("accept the canonical add, update, delete, and move grammar", async () => {
		const paths = await withFixture({
			"update.txt": "before\n",
			"delete.txt": "delete me\n",
			"move.txt": "move me\n",
		});
		const patch = `*** Begin Patch
*** Add File: add.txt
+added
*** Update File: update.txt
@@
-before
+after
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: moved.txt
@@
-move me
+moved
*** End Patch`;

		await Promise.all([applyAft(paths.aft, patch), applyCodex(paths.codex, patch)]);

		for (const file of ["add.txt", "update.txt", "moved.txt"] as const) {
			expect(await readBoth(paths, file)).toEqual(
				file === "add.txt"
					? ["added\n", "added\n"]
					: file === "update.txt"
						? ["after\n", "after\n"]
						: ["moved\n", "moved\n"],
			);
		}
		await expect(readFile(join(paths.aft, "delete.txt"), "utf8")).rejects.toThrow();
		await expect(readFile(join(paths.codex, "delete.txt"), "utf8")).rejects.toThrow();
		await expect(readFile(join(paths.aft, "move.txt"), "utf8")).rejects.toThrow();
		await expect(readFile(join(paths.codex, "move.txt"), "utf8")).rejects.toThrow();
	});

	test("accept equivalent whitespace-fuzzy and end-of-file updates", async () => {
		const paths = await withFixture({ "sample.txt": "first\nsecond\n" });
		const trailingSpaces = "   ";
		const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-second${trailingSpaces}
+last
*** End of File
*** End Patch`;

		await Promise.all([applyAft(paths.aft, patch), applyCodex(paths.codex, patch)]);
		expect(await readBoth(paths, "sample.txt")).toEqual(["first\nlast\n", "first\nlast\n"]);
	});

	test("documents AFT's permissive envelope grammar", async () => {
		const paths = await withFixture({ "sample.txt": "before\n" });
		const patch = `explanatory preface
*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** End Patch
trailing explanation`;

		await applyAft(paths.aft, patch);
		await expect(applyCodex(paths.codex, patch)).rejects.toThrow();
		expect(await readFile(join(paths.aft, "sample.txt"), "utf8")).toBe("after\n");
		expect(await readFile(join(paths.codex, "sample.txt"), "utf8")).toBe("before\n");
	});

	test("documents AFT's permissive empty update grammar", async () => {
		const paths = await withFixture({ "sample.txt": "before\n" });
		const patch = `*** Begin Patch
*** Update File: sample.txt
@@
*** End Patch`;

		await applyAft(paths.aft, patch);
		await expect(applyCodex(paths.codex, patch)).rejects.toThrow();
		expect(await readFile(join(paths.aft, "sample.txt"), "utf8")).toBe("before\n");
	});

	test("accept sequential duplicate-file actions", async () => {
		const paths = await withFixture({ "sample.txt": "before\n" });
		const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-before
+middle
*** Update File: sample.txt
@@
-middle
+after
*** End Patch`;

		await Promise.all([applyAft(paths.aft, patch), applyCodex(paths.codex, patch)]);
		expect(await readFile(join(paths.aft, "sample.txt"), "utf8")).toBe("after\n");
		expect(await readFile(join(paths.codex, "sample.txt"), "utf8")).toBe("after\n");
	});
});
