import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHepiProjectRoot } from "../../src/core/index.js";

describe("project root", () => {
	test("recognizes a linked worktree .git file from a nested directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "hepi-project-root-"));
		const nested = join(root, "nested", "dir");
		try {
			await mkdir(nested, { recursive: true });
			await writeFile(join(root, ".git"), "gitdir: /tmp/worktree.git\n");
			expect(await resolveHepiProjectRoot(nested)).toBe(root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
