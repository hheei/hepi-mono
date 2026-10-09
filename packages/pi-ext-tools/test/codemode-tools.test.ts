import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { registerBashTool } from "../src/bash.js";
import { createEvalRuntimeState } from "../src/eval/lifecycle.js";
import { createPythonEvalTool, pythonEvalPromptGuidelines } from "../src/eval/tool.js";
import { createFffRuntimeState } from "../src/fff/lifecycle.js";
import { registerFindTool } from "../src/find.js";
import { registerGrepTool } from "../src/grep.js";
import { registerReadTool } from "../src/read.js";
import { registerTaskTools } from "../src/task-tools.js";
import { toolFor, toolHost } from "./fixtures/harness.js";
import { temporaryDirectories } from "./fixtures/tmp-dir.js";

const temporaryDirectory = temporaryDirectories("hepi-codemode-test-");

describe("tools contract aligned with upstream pi 1.0.0", () => {
	test("read, grep, find contract aligned with upstream pi and declare readOnly hints", async () => {
		const host = toolHost();
		const state = createFffRuntimeState();
		registerReadTool(host.pi, state);
		registerGrepTool(host.pi, state);
		registerFindTool(host.pi, state);

		const read = toolFor(host.tools, "read");
		const grep = toolFor(host.tools, "grep");
		const find = toolFor(host.tools, "find");

		// Aligned with upstream: no outputSchema so codemode scripts receive raw string output directly
		// Upstream Pi 1.1.0 read declares outputSchema for text/image union; grep and find have no outputSchema
		expect(read.outputSchema).toBeDefined();
		expect(grep.outputSchema).toBeUndefined();
		expect(find.outputSchema).toBeUndefined();

		// Safe optimizations: declare readOnly & idempotent hints
		expect(read.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
		expect(grep.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
		expect(find.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });

		const dir = await temporaryDirectory();
		await mkdir(join(dir, "subdir"));
		const filePath = join(dir, "sample.txt");
		await writeFile(filePath, "alpha\nbeta\n", "utf8");

		const readResult = await read.execute("read-1", { path: "sample.txt" }, undefined, undefined, {
			cwd: dir,
		} as unknown as ExtensionToolContext);
		expect(readResult.structuredContent).toBe("alpha\nbeta\n");
		expect(readResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("alpha"),
		});

		const grepResult = await grep.execute("grep-1", { pattern: "alpha" }, undefined, undefined, {
			cwd: dir,
		} as unknown as ExtensionToolContext);
		expect(grepResult.structuredContent).toBeUndefined();
		expect(grepResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("alpha"),
		});

		const findResult = await find.execute("find-1", { pattern: "sample" }, undefined, undefined, {
			cwd: dir,
		} as unknown as ExtensionToolContext);
		expect(findResult.structuredContent).toBeUndefined();
		expect(findResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("sample.txt"),
		});
	});

	test("bash provides upstream-aligned bashOutputSchema and structuredContent", async () => {
		const host = toolHost();
		const state = createFffRuntimeState();
		registerBashTool(host.pi, state);

		const bash = toolFor(host.tools, "bash");
		expect(bash.outputSchema).toBeDefined();
		expect(bash.outputSchema).toMatchObject({
			type: "object",
			properties: {
				output: { type: "string" },
				truncated: { type: "boolean" },
				exit_code: { type: "number" },
				wall_time_seconds: { type: "number" },
			},
		});

		const dir = await temporaryDirectory();
		const successResult = await bash.execute(
			"bash-1",
			{ command: "echo 'hello from codemode bash'" },
			undefined,
			undefined,
			{ cwd: dir } as unknown as ExtensionToolContext,
		);

		expect(successResult.structuredContent).toBeDefined();
		const structured = successResult.structuredContent as {
			output: string;
			truncated: boolean;
			exit_code: number;
			wall_time_seconds: number;
		};
		expect(structured.exit_code).toBe(0);
		expect(structured.output).toContain("hello from codemode bash");
		expect(structured.truncated).toBe(false);
		expect(structured.wall_time_seconds).toBeGreaterThanOrEqual(0);
		expect(successResult.isError).toBeFalsy();

		const failResult = await bash.execute("bash-2", { command: "exit 42" }, undefined, undefined, {
			cwd: dir,
		} as unknown as ExtensionToolContext);

		expect(failResult.structuredContent).toBeDefined();
		const failStructured = failResult.structuredContent as {
			exit_code: number;
			wall_time_seconds: number;
		};
		expect(failStructured.exit_code).toBe(42);
		expect(failResult.isError).toBe(true);
	});

	test("bash prepareLoadout adapts description when eval tool is active", () => {
		const host = toolHost();
		const state = createFffRuntimeState();
		registerBashTool(host.pi, state);

		const bash = toolFor(host.tools, "bash");
		expect(bash.prepareLoadout).toBeDefined();

		const loadoutWithEval = {
			declared: [{ name: "bash" }, { name: "python_eval" }],
			callable: [{ name: "bash" }, { name: "python_eval" }],
			registered: [{ name: "bash" }, { name: "python_eval" }],
			getExposure: () => "direct" as const,
			getNamespace: () => undefined,
		};
		const changesWithEval = bash.prepareLoadout?.(loadoutWithEval as never);
		expect(changesWithEval?.descriptions?.bash).toContain("Prefer python_eval over python -c");

		const loadoutWithBoth = {
			declared: [{ name: "bash" }, { name: "python_eval" }, { name: "codemode" }],
			callable: [{ name: "bash" }, { name: "python_eval" }, { name: "codemode" }],
			registered: [{ name: "bash" }, { name: "python_eval" }, { name: "codemode" }],
			getExposure: () => "direct" as const,
			getNamespace: () => undefined,
		};
		const changesWithBoth = bash.prepareLoadout?.(loadoutWithBoth as never);
		expect(changesWithBoth?.descriptions?.bash).toContain(
			"Prefer python_eval for persistent Python computation, and codemode for tool orchestration or filtering.",
		);

		const loadoutWithCodemodeOnly = {
			declared: [{ name: "bash" }, { name: "codemode" }],
			callable: [{ name: "bash" }, { name: "codemode" }],
			registered: [{ name: "bash" }, { name: "codemode" }],
			getExposure: () => "direct" as const,
			getNamespace: () => undefined,
		};
		const changesWithCodemodeOnly = bash.prepareLoadout?.(loadoutWithCodemodeOnly as never);
		expect(changesWithCodemodeOnly?.descriptions?.bash).toContain(
			"Prefer codemode over complex shell loops or pipeline filtering.",
		);

		const loadoutWithoutEval = {
			declared: [{ name: "bash" }],
			callable: [{ name: "bash" }],
			registered: [{ name: "bash" }],
			getExposure: () => "direct" as const,
			getNamespace: () => undefined,
		};
		const changesWithoutEval = bash.prepareLoadout?.(loadoutWithoutEval as never);
		expect(changesWithoutEval?.descriptions?.bash).toBeUndefined();
	});

	test("task tools declare defaultActive false and appropriate annotations", () => {
		const host = toolHost();
		const state = createFffRuntimeState();
		registerTaskTools(host.pi, state);

		const listTasks = toolFor(host.tools, "list_jobs");
		const waitTasks = toolFor(host.tools, "wait_jobs");
		const stopTasks = toolFor(host.tools, "stop_jobs");

		expect(listTasks.defaultActive).toBe(false);
		expect(listTasks.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });

		expect(waitTasks.defaultActive).toBe(false);
		expect(waitTasks.annotations).toEqual({ readOnlyHint: true, idempotentHint: false });

		expect(stopTasks.defaultActive).toBe(false);
		expect(stopTasks.annotations).toEqual({ destructiveHint: true });
	});

	test("python_eval prompt guidelines describe nested tool return types aligned with codemode", () => {
		const guidelines = pythonEvalPromptGuidelines();
		expect(
			guidelines.some((line) =>
				line.includes("nested tools return text strings, or structured dicts"),
			),
		).toBe(true);
		expect(
			guidelines.some((line) =>
				line.includes("Call nested tools as `tools.name(...)` with kwargs or a dict."),
			),
		).toBe(true);
	});

	test("python_eval tool declares exposure: model-only so it survives codemode.mode = only", () => {
		const evalTool = createPythonEvalTool(createEvalRuntimeState(), {} as never);
		expect(evalTool.exposure).toBe("model-only");

		// Simulate upstream codemode prepareCodemodeLoadout behavior under mode === "only"
		const isDirect = (tool: { exposure?: string }) => tool.exposure === "direct";
		const directTool = { name: "read", exposure: "direct" as const };
		const tools = [directTool, evalTool];

		// Upstream only hides tools whose exposure is "direct"
		const hiddenDeclarations = tools.filter((tool) => isDirect(tool)).map((tool) => tool.name);

		expect(hiddenDeclarations).toContain("read");
		expect(hiddenDeclarations).not.toContain("python_eval");
	});
});
