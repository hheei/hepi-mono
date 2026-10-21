import { describe, expect, test } from "vitest";
import patchExtension from "../../pi-apply-patch/src/extension.js";
import bashExtension from "../../pi-bg-bash/src/extension.js";
import pythonExtension from "../../pi-python-eval/src/extension.js";
import todoExtension from "../../pi-todo/src/extension.js";
import filesExtension from "../src/extension.js";
import { toolFor, toolHost } from "./fixtures/harness.js";

const packages = [
	["files", filesExtension, ["read", "grep", "find", "edit", "write", "bash", "tool_search"]],
	["background bash", bashExtension, ["bg_bash_spawn", "bg_bash_get", "bg_bash_stop"]],
	["patch", patchExtension, ["apply_patch"]],
	["python", pythonExtension, ["python_eval"]],
	["todo", todoExtension, ["todo"]],
] as const;

describe("independent tool extensions", () => {
	test.each(packages)("%s registers only its own catalog", (_name, extension, expected) => {
		const host = toolHost();
		extension(host.pi);
		expect(host.tools.map((tool) => tool.name)).toEqual(expected);
	});

	test.each([
		false,
		true,
	])("composition preserves defaults and unique names (reverse: %s)", (reverse) => {
		const host = toolHost();
		for (const [, extension] of reverse ? [...packages].reverse() : packages) extension(host.pi);
		const names = host.tools.map((tool) => tool.name);
		expect(new Set(names).size).toBe(13);
		expect(names).toHaveLength(13);
		for (const name of [
			"apply_patch",
			"python_eval",
			"todo",
			"bg_bash_spawn",
			"bg_bash_get",
			"bg_bash_stop",
		]) {
			expect(toolFor(host.tools, name).defaultActive).toBe(false);
		}
		expect(toolFor(host.tools, "python_eval").exposure).toBe("model-only");
		for (const name of ["bg_bash_spawn", "bg_bash_get", "bg_bash_stop"])
			expect(toolFor(host.tools, name).exposure).toBe("deferred");
		expect(host.activeTools()).toEqual(["read", "bash", "edit", "write"]);
	});
});
