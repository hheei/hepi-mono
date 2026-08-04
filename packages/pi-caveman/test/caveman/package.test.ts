import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "../..");

describe("Caveman package", () => {
	test("publishes one independent Pi extension entry", async () => {
		const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
		expect(manifest).toMatchObject({ pi: { extensions: ["dist/extension.js"] } });
	});
});
