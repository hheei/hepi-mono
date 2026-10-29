import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import pythonEvalExtension from "../src/extension.js";
import { createEvalRuntime } from "../src/lifecycle.js";
import { createEvalSettingsProvider, readEvalSettings } from "../src/settings.js";
import { createPythonEvalTool, pythonEvalPromptGuidelines } from "../src/tool.js";
import { toolFor, toolHost } from "./fixtures/harness.js";

describe("pi-python-eval extension", () => {
	test("registers python_eval alone, inactive until named", () => {
		const host = toolHost();
		pythonEvalExtension(host.pi);

		expect(host.tools.map((tool) => tool.name)).toEqual(["python_eval"]);
		const tool = toolFor(host.tools, "python_eval");
		expect(tool.defaultActive).toBe(false);
		expect(tool.exposure).toBe("model-only");
		expect(host.activeTools()).not.toContain("python_eval");
	});

	test("reaches only the seven nested tools it may call", () => {
		const host = toolHost();
		pythonEvalExtension(host.pi);
		const tool = toolFor(host.tools, "python_eval");
		// The bridge whitelist and the declared reach stay the same set: no tool can be reached
		// through the loadout that the bridge would refuse, and none is hidden from it.
		expect([...(tool.reachesTools?.({}) ?? [])].sort()).toEqual([
			"apply_patch",
			"bash",
			"edit",
			"find",
			"grep",
			"read",
			"write",
		]);
	});

	test("prompt guidelines describe how nested tools return values", () => {
		const guidelines = pythonEvalPromptGuidelines();
		expect(
			guidelines.some((line) =>
				line.includes("nested tools return text strings, or structured dicts"),
			),
		).toBe(true);
		expect(
			guidelines.some(
				(line) =>
					line.includes("Nested tools are synchronous: `result = tools.name(...)`") &&
					line.includes("kwargs or a dict") &&
					line.includes("do not use await"),
			),
		).toBe(true);
	});

	test("declares exposure: model-only so it survives codemode.mode = only", () => {
		const evalTool = createPythonEvalTool(createEvalRuntime().state, {} as never);
		expect(evalTool.exposure).toBe("model-only");

		// Upstream codemode hides only tools whose exposure is "direct" under mode === "only".
		const isDirect = (tool: { exposure?: string }): boolean => tool.exposure === "direct";
		const tools = [{ name: "read", exposure: "direct" as const }, evalTool];
		const hiddenDeclarations = tools.filter(isDirect).map((tool) => tool.name);

		expect(hiddenDeclarations).toContain("read");
		expect(hiddenDeclarations).not.toContain("python_eval");
	});

	test("registers its settings provider under the eval group", () => {
		const provider = createEvalSettingsProvider();
		expect(provider.id).toBe("pi-python-eval.eval");
		expect(provider.origin).toBe("@hheei/pi-python-eval");
		expect(provider.groups.map((group) => group.id)).toEqual(["eval"]);
		expect(provider.groups[0]?.fields.map((field) => field.id)).toEqual(["pythonBin"]);
	});
});

describe("Eval settings", () => {
	test("reads and trims pythonBin from the shared eval group", async () => {
		const directory = await mkdtemp(join(tmpdir(), "eval-settings-"));
		const path = join(directory, "ext_settings.json");
		try {
			await writeFile(path, JSON.stringify({ eval: { pythonBin: " /usr/bin/python3 " } }));
			expect(readEvalSettings(path)).toEqual({ pythonBin: "/usr/bin/python3" });
			await writeFile(path, JSON.stringify({ eval: { pythonBin: "  " } }));
			expect(readEvalSettings(path)).toEqual({ pythonBin: undefined });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
