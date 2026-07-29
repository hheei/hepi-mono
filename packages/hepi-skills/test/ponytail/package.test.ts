import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "../..");

describe("HEPI skills package", () => {
	test("publishes one extension and its Loadout-discoverable auxiliary skills", async () => {
		const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
		expect(manifest).toMatchObject({
			pi: { extensions: ["./dist/extension.js"], skills: ["./dist/skills"] },
		});
		expect((await readdir(join(packageRoot, "src", "skills"))).sort()).toEqual([
			"domain-modeling",
			"grill-me",
			"grill-with-docs",
			"grilling",
			"ponytail-audit",
			"ponytail-debt",
			"ponytail-gain",
			"ponytail-help",
			"ponytail-review",
		]);
		const grillMe = await readFile(
			join(packageRoot, "src", "skills", "grill-me", "SKILL.md"),
			"utf8",
		);
		const grillWithDocs = await readFile(
			join(packageRoot, "src", "skills", "grill-with-docs", "SKILL.md"),
			"utf8",
		);
		expect(grillMe).toContain("disable-model-invocation: true");
		expect(grillWithDocs).toContain("disable-model-invocation: true");
	});
});
