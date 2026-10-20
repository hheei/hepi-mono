import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import patchExtension from "../../pi-apply-patch/src/extension.js";
import bashExtension from "../../pi-bg-bash/src/extension.js";
import { mutationLockPath } from "../../pi-ext-core/src/mutation-lock.js";
import pythonExtension from "../../pi-python-eval/src/extension.js";
import todoExtension from "../../pi-todo/src/extension.js";
import filesExtension from "../src/extension.js";
import { toolFor, toolHost } from "./fixtures/harness.js";
import { temporaryDirectories } from "./fixtures/tmp-dir.js";

const temporaryDirectory = temporaryDirectories("hepi-tool-packages-");
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

describe("shared workspace mutation protocol", () => {
	test.each([
		["edit", filesExtension, { path: "value.txt", oldText: "before", newText: "after" }],
		["write", filesExtension, { path: "value.txt", content: "after\n" }],
		[
			"apply_patch",
			patchExtension,
			{ patch: "*** Begin Patch\n*** Update File: value.txt\n-before\n+after\n*** End Patch" },
		],
	] satisfies [
		string,
		(pi: ExtensionAPI) => void,
		object,
	][])("%s waits on the existing lock and cancels without writing", async (name, extension, args) => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "value.txt"), "before\n");
		const server = createServer((socket) => socket.end());
		const listening = once(server, "listening");
		server.listen(mutationLockPath(cwd));
		await listening;
		const controller = new AbortController();
		try {
			const host = toolHost();
			extension(host.pi);
			const connected = once(server, "connection");
			const execution = toolFor(host.tools, name).execute(
				"lock-check",
				args,
				controller.signal,
				undefined,
				{ cwd } as never,
			);
			const rejected = expect(execution).rejects.toThrow("cancelled waiter");
			await connected;
			expect(await readFile(join(cwd, "value.txt"), "utf8")).toBe("before\n");
			controller.abort(new Error("cancelled waiter"));
			await rejected;
			expect(await readFile(join(cwd, "value.txt"), "utf8")).toBe("before\n");
		} finally {
			controller.abort();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
