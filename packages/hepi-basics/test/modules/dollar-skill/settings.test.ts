import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadDollarSkillConfig,
	normalizeDollarSkillConfig,
	saveDollarSkillConfig,
} from "../../../src/dollar-skill/config.js";
import { createDollarSkillSettingsProvider } from "../../../src/dollar-skill/index.js";

describe("dollar skill settings", () => {
	test("normalizes untrusted values", () => {
		expect(normalizeDollarSkillConfig({ enabled: false, maxSuggestions: 500 })).toEqual({
			enabled: false,
			maxSuggestions: 50,
		});
		expect(normalizeDollarSkillConfig({ enabled: "no", maxSuggestions: 1.5 })).toEqual({
			enabled: true,
			maxSuggestions: 50,
		});
	});

	test("round-trips its section without overwriting sibling settings", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-basics-dollar-"));
		const settingsPath = join(cwd, "settings.json");
		await Bun.write(
			settingsPath,
			JSON.stringify({ "pi-basics": { rtk: { mode: "suggest" } }, external: true }),
		);
		await saveDollarSkillConfig(cwd, { enabled: false, maxSuggestions: 7 });
		expect(await loadDollarSkillConfig(cwd)).toEqual({ enabled: false, maxSuggestions: 7 });
		const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(parsed).toEqual({
			"pi-basics": {
				rtk: { mode: "suggest" },
				dollarSkillReferences: { enabled: false, maxSuggestions: 7 },
			},
			external: true,
		});
	});

	test("uses unique temporary files for concurrent saves", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-basics-dollar-concurrent-"));
		await Promise.all([
			saveDollarSkillConfig(cwd, { enabled: true, maxSuggestions: 3 }),
			saveDollarSkillConfig(cwd, { enabled: false, maxSuggestions: 7 }),
		]);
		expect(await readdir(cwd)).toEqual(["settings.json"]);
	});

	test("provider validates limits without changing a live feature", async () => {
		const settingsDirectory = await mkdtemp(join(tmpdir(), "pi-basics-dollar-provider-"));
		const provider = createDollarSkillSettingsProvider({ settingsDirectory });
		const group = provider.groups[0];
		const limit = group?.fields.find((field) => field.id === "maxSuggestions");
		expect(limit?.validate?.(0)).toContain("1 to 50");
		expect(limit?.validate?.(10)).toBeUndefined();
		await provider.storage.save(
			{ dollarSkillReferences: { enabled: false, maxSuggestions: 3 } },
			{ sessionId: "test", cwd: settingsDirectory },
		);
		expect(await loadDollarSkillConfig(settingsDirectory)).toEqual({
			enabled: false,
			maxSuggestions: 3,
		});
	});
});
