import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hePiExtensions } from "../src/index.js";

describe("unified HEPI loader", () => {
	test("keeps foundational registration first and loads each runtime module once", async () => {
		expect(hePiExtensions.length).toBeGreaterThanOrEqual(17);
		expect(hePiExtensions.length).toBeLessThanOrEqual(20);
		expect(new Set(hePiExtensions).size).toBe(hePiExtensions.length);
		expect(hePiExtensions[0]?.name).toBe("piBasicsExtension");
		expect(hePiExtensions[1]?.name).toBe("piLoadoutExtension");
		expect(hePiExtensions.some((extension) => extension.name === "piDebugExtension")).toBe(false);
	});

	test("publishes one Pi extension entry", async () => {
		const manifest: unknown = JSON.parse(
			await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
		);
		expect(manifest).toMatchObject({ pi: { extensions: ["dist/extension.js"] } });
	});
});
