import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createProjectIdentityResolver } from "../src/project-identity.js";

function directoryIdentity(path: string): string {
	return `dir:${createHash("sha256").update(path).digest("hex")}`;
}

test("uses Git root commit across canonical worktree paths", async (): Promise<void> => {
	const resolver = createProjectIdentityResolver({
		canonicalize: async () => "/repository/worktree",
		gitRootCommit: async () => "a".repeat(40),
		lastKnownGitIdentity: new Map(),
	});
	expect(await resolver.resolve("/symlinked/worktree")).toBe(`git:${"a".repeat(40)}`);
});

test("hashes the canonical directory without persisting its raw path", async (): Promise<void> => {
	const resolver = createProjectIdentityResolver({
		canonicalize: async () => "/non-git/project",
		gitRootCommit: async () => undefined,
		lastKnownGitIdentity: new Map(),
	});
	expect(await resolver.resolve("/non-git/project")).toBe(directoryIdentity("/non-git/project"));
});

test("reuses only process-local known Git identity after command failure", async (): Promise<void> => {
	let result: string | undefined = "b".repeat(40);
	const resolver = createProjectIdentityResolver({
		canonicalize: async () => "/repository/worktree",
		gitRootCommit: async () => result,
		lastKnownGitIdentity: new Map(),
	});
	expect(await resolver.resolve("/repository/worktree")).toBe(`git:${"b".repeat(40)}`);
	result = undefined;
	expect(await resolver.resolve("/repository/worktree")).toBe(`git:${"b".repeat(40)}`);
});

test("propagates canonicalization failure and cancellation", async (): Promise<void> => {
	const failing = createProjectIdentityResolver({
		canonicalize: async () => {
			throw new Error("permission denied");
		},
		lastKnownGitIdentity: new Map(),
	});
	await expect(failing.resolve("/denied")).rejects.toThrow("permission denied");

	const controller = new AbortController();
	controller.abort();
	const resolver = createProjectIdentityResolver({
		canonicalize: async () => "/project",
		lastKnownGitIdentity: new Map(),
	});
	await expect(resolver.resolve("/project", controller.signal)).rejects.toThrow();
});
