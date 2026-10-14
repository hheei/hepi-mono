import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readEvalSettings } from "../src/eval/settings.js";

describe("Eval settings", () => {
	test("reads and trims pythonBin", async () => {
		const directory = await mkdtemp(join(tmpdir(), "eval-settings-"));
		const path = join(directory, "ext_settings.json");
		await writeFile(path, JSON.stringify({ eval: { pythonBin: " /usr/bin/python3 " } }));
		expect(readEvalSettings(path)).toEqual({ pythonBin: "/usr/bin/python3" });
		await writeFile(path, JSON.stringify({ eval: { pythonBin: "  " } }));
		expect(readEvalSettings(path)).toEqual({ pythonBin: undefined });
	});
});
