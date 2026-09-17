import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_APPLY_PATCH_POLICY, loadApplyPatchPolicy } from "../src/apply-patch/policy.js";

let paths: { globalPath: string; projectPath: string; root: string };

beforeEach(async () => {
	const root = await mkdtemp(join(tmpdir(), "hepi-apply-patch-policy-"));
	paths = { root, globalPath: join(root, "global.json"), projectPath: join(root, "project.json") };
});

afterEach(async () => {
	await rm(paths.root, { recursive: true, force: true });
});

async function save(path: string, applyPatch: Record<string, unknown>): Promise<void> {
	await writeFile(path, JSON.stringify({ "pi-ext-tools": { applyPatch } }), "utf8");
}

describe("apply-patch policy", () => {
	test("uses defaults and accepts global fuzzFactor bounds", async () => {
		expect(await loadApplyPatchPolicy({ paths })).toEqual(DEFAULT_APPLY_PATCH_POLICY);
		for (const fuzzFactor of [0, 2]) {
			await save(paths.globalPath, { fuzzFactor });
			expect(await loadApplyPatchPolicy({ paths })).toEqual({ fuzzFactor });
		}
	});

	test("allows project tightening but not relaxation", async () => {
		await save(paths.globalPath, { fuzzFactor: 2 });
		for (const fuzzFactor of [0, 2]) {
			await save(paths.projectPath, { fuzzFactor });
			expect(await loadApplyPatchPolicy({ paths })).toEqual({ fuzzFactor });
		}
		await save(paths.globalPath, { fuzzFactor: 0 });
		await save(paths.projectPath, { fuzzFactor: 2 });
		await expect(loadApplyPatchPolicy({ paths })).rejects.toThrow(
			"project setting pi-ext-tools.applyPatch.fuzzFactor must not exceed global value 0",
		);
	});

	test("rejects invalid fuzz factors and retired matcher keys", async () => {
		for (const fuzzFactor of [-1, 0.5, 3]) {
			await save(paths.globalPath, { fuzzFactor });
			await expect(loadApplyPatchPolicy({ paths })).rejects.toThrow(
				"global setting pi-ext-tools.applyPatch.fuzzFactor must be an integer from 0 to 2",
			);
		}
		for (const [key, value] of [
			["minSimilarity", 0.7],
			["maxConcurrentWorkers", 2],
			["maxQueueDepth", 32],
		] as const) {
			await save(paths.globalPath, { [key]: value });
			await expect(loadApplyPatchPolicy({ paths })).rejects.toThrow(
				`global setting pi-ext-tools.applyPatch.${key} is not supported`,
			);
		}
	});
});
