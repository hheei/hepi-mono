import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hepiExtensions } from "../src/index.js";

describe("unified HEPI loader", () => {
	test("keeps foundational registration first and loads each runtime module once", async () => {
		expect(hepiExtensions.length).toBeGreaterThanOrEqual(17);
		expect(hepiExtensions.length).toBeLessThanOrEqual(20);
		expect(new Set(hepiExtensions).size).toBe(hepiExtensions.length);
		expect(hepiExtensions[0]?.name).toBe("piBasicsExtension");
		expect(hepiExtensions[1]?.name).toBe("piLoadoutExtension");
		expect(hepiExtensions.some((extension) => extension.name === "piDebugExtension")).toBe(false);
	});

	test("publishes one Pi extension entry", async () => {
		const manifest: unknown = JSON.parse(
			await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
		);
		expect(manifest).toMatchObject({ pi: { extensions: ["dist/extension.js"] } });
	});
});
