import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_FUZZY_APPLY_PATCH_POLICY,
	loadFuzzyApplyPatchPolicy,
} from "../src/apply-patch/policy.js";

async function settingsPaths(): Promise<{ globalPath: string; projectPath: string; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "hepi-apply-patch-policy-"));
	return { root, globalPath: join(root, "global.json"), projectPath: join(root, "project.json") };
}

async function save(path: string, applyPatch: Record<string, unknown>): Promise<void> {
	await writeFile(path, JSON.stringify({ "pi-ext-tools": { applyPatch } }), "utf8");
}

describe("fuzzy apply-patch policy", () => {
	test("uses defaults when settings are absent", async () => {
		const paths = await settingsPaths();
		try {
			expect(await loadFuzzyApplyPatchPolicy({ paths })).toEqual(DEFAULT_FUZZY_APPLY_PATCH_POLICY);
		} finally {
			await rm(paths.root, { recursive: true, force: true });
		}
	});
	test("loads valid global settings", async () => {
		const paths = await settingsPaths();
		try {
			await save(paths.globalPath, {
				enabled: false,
				minSimilarity: 0.9,
				allowFuzzy: false,
				maxConcurrentWorkers: 4,
				maxQueueDepth: 100,
				cacheMiB: 128,
			});
			expect(await loadFuzzyApplyPatchPolicy({ paths })).toEqual({
				enabled: false,
				minSimilarity: 0.9,
				allowFuzzy: false,
				maxConcurrentWorkers: 4,
				maxQueueDepth: 100,
				cacheMiB: 128,
			});
		} finally {
			await rm(paths.root, { recursive: true, force: true });
		}
	});
	test("allows project tightening only", async () => {
		const paths = await settingsPaths();
		try {
			await save(paths.globalPath, {
				minSimilarity: 0.8,
				maxConcurrentWorkers: 4,
				maxQueueDepth: 100,
				cacheMiB: 128,
			});
			await save(paths.projectPath, {
				enabled: false,
				allowFuzzy: false,
				minSimilarity: 0.9,
				maxConcurrentWorkers: 2,
				maxQueueDepth: 20,
				cacheMiB: 64,
			});
			expect(await loadFuzzyApplyPatchPolicy({ paths })).toEqual({
				enabled: false,
				minSimilarity: 0.9,
				allowFuzzy: false,
				maxConcurrentWorkers: 2,
				maxQueueDepth: 20,
				cacheMiB: 64,
			});
		} finally {
			await rm(paths.root, { recursive: true, force: true });
		}
	});
	test("rejects project weakening", async () => {
		const paths = await settingsPaths();
		try {
			await save(paths.globalPath, { minSimilarity: 0.9, maxConcurrentWorkers: 2 });
			await save(paths.projectPath, { minSimilarity: 0.8 });
			await expect(loadFuzzyApplyPatchPolicy({ paths })).rejects.toThrow(
				"project setting pi-ext-tools.applyPatch.minSimilarity",
			);
		} finally {
			await rm(paths.root, { recursive: true, force: true });
		}
	});
	test("rejects invalid values with layer and key", async () => {
		const paths = await settingsPaths();
		try {
			await save(paths.globalPath, { minSimilarity: null });
			await expect(loadFuzzyApplyPatchPolicy({ paths })).rejects.toThrow(
				"global setting pi-ext-tools.applyPatch.minSimilarity",
			);
			await save(paths.globalPath, { maxConcurrentWorkers: 0 });
			await expect(loadFuzzyApplyPatchPolicy({ paths })).rejects.toThrow(
				"global setting pi-ext-tools.applyPatch.maxConcurrentWorkers",
			);
		} finally {
			await rm(paths.root, { recursive: true, force: true });
		}
	});
});
