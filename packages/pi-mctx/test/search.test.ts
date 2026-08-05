import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { collectMctxExternalSearchCandidates, rankMctxSearchCandidates } from "../src/search.js";

const execFileAsync = promisify(execFile);

test("ranks admitted lexical candidates by score then stable source identity", (): void => {
	expect(
		rankMctxSearchCandidates(
			"alpha beta",
			[
				{ source: "history", id: "history-b", title: "History", text: "alpha beta" },
				{ source: "memory", id: "memory-b", title: "Memory B", text: "alpha beta" },
				{ source: "memory", id: "memory-a", title: "Memory A", text: "alpha beta" },
				{ source: "note", id: "note-a", title: "Note", text: "alpha" },
			],
			3,
		),
	).toMatchObject([
		{ source: "memory", id: "memory-a" },
		{ source: "history", id: "history-b" },
		{ source: "note", id: "note-a" },
	]);
});

test("collapses duplicate source identities and exact source content deterministically", (): void => {
	expect(
		rankMctxSearchCandidates(
			"alpha beta",
			[
				{ source: "memory", id: "same", title: "Lower", text: "alpha" },
				{ source: "memory", id: "same", title: "Higher", text: "alpha beta" },
				{ source: "memory", id: "content-b", title: "Duplicate", text: "alpha beta" },
				{ source: "note", id: "other-source", title: "Note", text: "alpha beta" },
			],
			10,
		),
	).toMatchObject([
		{ source: "memory", id: "content-b", title: "Duplicate" },
		{ source: "note", id: "other-source", title: "Note" },
	]);
});

test("rejects primer symlinks resolving outside project root", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "pi-mctx-search-"));
	const project = join(directory, "project");
	const outside = join(directory, "outside");
	try {
		await mkdir(project);
		await mkdir(outside);
		const secret = join(outside, "primer.md");
		await writeFile(secret, "outside secret", "utf8");
		await symlink(secret, join(project, "primer.md"));
		expect(
			await collectMctxExternalSearchCandidates({
				cwd: project,
				primerPath: "primer.md",
				sources: ["primer"],
				signal: new AbortController().signal,
			}),
		).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("reads bounded local Git commit metadata without a remote", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "pi-mctx-search-git-"));
	try {
		await execFileAsync("git", ["init", "-q"], { cwd: directory });
		await execFileAsync("git", ["config", "user.name", "MCTX Test"], { cwd: directory });
		await execFileAsync("git", ["config", "user.email", "mctx@example.test"], { cwd: directory });
		await writeFile(join(directory, "README.md"), "fixture", "utf8");
		await execFileAsync("git", ["add", "README.md"], { cwd: directory });
		await execFileAsync("git", ["commit", "-qm", "target search commit"], { cwd: directory });
		const candidates = await collectMctxExternalSearchCandidates({
			cwd: directory,
			sources: ["git"],
			signal: new AbortController().signal,
		});
		expect(candidates).toHaveLength(1);
		const candidate = candidates[0];
		if (candidate === undefined) throw new Error("Expected Git candidate");
		expect(candidate.source).toBe("git");
		expect(candidate.title).toContain("target search commit");
		expect(candidate.text).toContain("target search commit");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
