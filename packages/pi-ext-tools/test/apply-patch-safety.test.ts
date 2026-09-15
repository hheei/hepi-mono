import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyPatchInWorkspace } from "../src/apply-patch/executor.js";
import { createLocalPatchFs, FsTransportError } from "../src/apply-patch/fs.js";
import {
	DEFAULT_FUZZY_APPLY_PATCH_POLICY,
	type FuzzyApplyPatchPolicy,
} from "../src/apply-patch/policy.js";

const temporaryPaths: string[] = [];
const noFuzzy: FuzzyApplyPatchPolicy = {
	...DEFAULT_FUZZY_APPLY_PATCH_POLICY,
	minSimilarity: 0,
};
const movePatch =
	"*** Begin Patch\n" +
	"*** Update File: source.txt\n" +
	"*** Move to: destination.txt\n" +
	"-before\n+patched\n" +
	"*** End Patch";

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-apply-patch-safety-"));
	temporaryPaths.push(path);
	return path;
}

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("apply-patch publication safety", () => {
	test("preserves external files that change while writes are staged", async () => {
		const cases = [
			{
				path: "value.txt",
				initial: "before\n",
				patch: "*** Begin Patch\n*** Update File: value.txt\n-before\n+patched\n*** End Patch",
				external: "external update\n",
			},
			{
				path: "appeared.txt",
				patch: "*** Begin Patch\n*** Add File: appeared.txt\n+patched\n*** End Patch",
				external: "external target\n",
			},
		];
		for (const { path, initial, patch, external } of cases) {
			const root = await temporaryDirectory();
			if (initial !== undefined) await writeFile(join(root, path), initial, "utf8");
			const local = createLocalPatchFs(root);
			let injected = false;
			const fs = {
				...local,
				async writeAtomic(
					stagedPath: string,
					data: Uint8Array,
					mode: number | undefined,
					signal?: AbortSignal,
				): Promise<void> {
					await local.writeAtomic(stagedPath, data, mode, signal);
					if (!injected) {
						injected = true;
						await writeFile(join(root, path), external, "utf8");
					}
				},
			};
			const result = await applyPatchInWorkspace({
				workspaceRoot: root,
				policy: noFuzzy,
				fs,
				patch,
			});
			expect(result.changedPaths).toEqual([]);
			expect(result.rejected).toMatchObject([{ paths: [path] }]);
			expect(await readFile(join(root, path), "utf8")).toBe(external);
			expect((await local.list(".")).some((name) => name.includes(".agentpatch-"))).toBe(false);
		}
	});

	test("preserves an external delete source edit after the baseline read", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "value.txt"), "before\n", "utf8");
		const local = createLocalPatchFs(root);
		let sourceReads = 0;
		const fs = {
			...local,
			async readFollow(
				path: string,
				signal?: AbortSignal,
				timeoutMs?: number,
			): Promise<Uint8Array> {
				const bytes = await local.readFollow(path, signal, timeoutMs);
				if (path === "value.txt" && sourceReads++ === 0)
					await writeFile(join(root, "value.txt"), "external delete edit\n", "utf8");
				return bytes;
			},
		};

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			fs,
			patch: "*** Begin Patch\n*** Delete File: value.txt\n*** End Patch",
		});

		expect(result.changedPaths).toEqual([]);
		expect(result.rejected).toMatchObject([{ paths: ["value.txt"] }]);
		expect(result.unconfirmed).toEqual([]);
		expect(await readFile(join(root, "value.txt"), "utf8")).toBe("external delete edit\n");
	});

	test("keeps an externally changed move source after publishing the destination", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "source.txt"), "before\n", "utf8");
		const local = createLocalPatchFs(root);
		const fs = {
			...local,
			async renameNew(from: string, to: string, signal?: AbortSignal): Promise<void> {
				await local.renameNew(from, to, signal);
				if (to === "destination.txt")
					await writeFile(join(root, "source.txt"), "external source edit\n", "utf8");
			},
		};

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			fs,
			patch: movePatch,
		});

		expect(result.changedPaths).toEqual(["destination.txt"]);
		expect(result.rejected).toMatchObject([{ paths: ["source.txt"] }]);
		expect(result.unconfirmed).toEqual([]);
		expect(await readFile(join(root, "source.txt"), "utf8")).toBe("external source edit\n");
		expect(await readFile(join(root, "destination.txt"), "utf8")).toBe("patched\n");
	});

	test("treats a source read failure before move removal as a confirmed partial result", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "source.txt"), "before\n", "utf8");
		const local = createLocalPatchFs(root);
		let destinationPublished = false;
		const fs = {
			...local,
			async renameNew(from: string, to: string, signal?: AbortSignal): Promise<void> {
				await local.renameNew(from, to, signal);
				destinationPublished ||= to === "destination.txt";
			},
			async readFollow(
				path: string,
				signal?: AbortSignal,
				timeoutMs?: number,
			): Promise<Uint8Array> {
				if (destinationPublished && path === "source.txt")
					throw new FsTransportError("write", true, "source read failed before removal");
				return await local.readFollow(path, signal, timeoutMs);
			},
		};

		const result = await applyPatchInWorkspace({
			workspaceRoot: root,
			policy: noFuzzy,
			fs,
			patch: movePatch,
		});

		expect(result.changedPaths).toEqual(["destination.txt"]);
		expect(result.rejected).toMatchObject([{ paths: ["source.txt"] }]);
		expect(result.unconfirmed).toEqual([]);
		expect(await readFile(join(root, "source.txt"), "utf8")).toBe("before\n");
		expect(await readFile(join(root, "destination.txt"), "utf8")).toBe("patched\n");
	});

	test("cleans unpublished temporary files even after cancellation", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "value.txt"), "before\n");
		const local = createLocalPatchFs(root);
		const controller = new AbortController();
		const fs = {
			...local,
			async writeAtomic(...args: Parameters<typeof local.writeAtomic>): Promise<void> {
				await local.writeAtomic(...args);
				controller.abort();
			},
		};
		await expect(
			applyPatchInWorkspace({
				workspaceRoot: root,
				policy: noFuzzy,
				fs,
				signal: controller.signal,
				patch: "*** Begin Patch\n*** Update File: value.txt\n-before\n+patched\n*** End Patch",
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(await local.list(".")).toEqual(["value.txt"]);
		expect(await readFile(join(root, "value.txt"), "utf8")).toBe("before\n");
	});
});
