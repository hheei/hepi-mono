import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");

describe("Ponytail package", () => {
	test("publishes one extension and five auxiliary skills", async () => {
		const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
		expect(manifest).toMatchObject({
			pi: { extensions: ["src/index.ts"], skills: ["skills"] },
		});
		expect((await readdir(join(packageRoot, "skills"))).sort()).toEqual([
			"ponytail-audit",
			"ponytail-debt",
			"ponytail-gain",
			"ponytail-help",
			"ponytail-review",
		]);
	});
});
