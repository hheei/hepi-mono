import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionToolContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import { MAX_HL_CHARS } from "../src/edit.js";
import { startTaskControl, TASK_TOOL_IDS } from "../src/task-tools.js";
import { activateApplyPatchTool, activatePythonEvalCatalog, registerTools } from "../src/tools.js";
import { toolFor, toolHost } from "./fixtures/harness.js";
import { plainTheme, roleTheme, taggedTheme } from "./fixtures/theme.js";
import { temporaryDirectories } from "./fixtures/tmp-dir.js";

const temporaryDirectory = temporaryDirectories("hepi-ext-tools-");

const renderContext = { isError: false, isPartial: false, lastComponent: undefined } as never;
const _renderCallContext = { isError: false, isPartial: true, lastComponent: undefined } as never;

function activatePatch(host: ReturnType<typeof toolHost>, enabled: boolean): void {
	activateApplyPatchTool(
		{
			pi: host.pi,
			resources: { add: (): void => undefined },
		} as unknown as ExtensionLifecycleContext,
		enabled,
	);
}

/** A capturing host with the standard tool catalog registered. */
function registeredTools(): ReturnType<typeof toolHost> {
	const host = toolHost();
	registerTools(host.pi);
	return host;
}

describe("pi-ext-tools catalog", () => {
	test("registers every canonical editing definition before catalog activation", (): void => {
		const host = registeredTools();
		const names = host.tools.map((tool) => tool.name);
		expect(names).toEqual([
			"read",
			"grep",
			"find",
			"edit",
			"write",
			"bash",
			"list_jobs",
			"wait_jobs",
			"stop_jobs",
			"apply_patch",
			"python_eval",
		]);
		expect(names.filter((name) => name === "apply_patch")).toHaveLength(1);
	});

	test("keeps task-control tools out of the catalog until the first task starts", (): void => {
		const host = registeredTools();
		const catalog = host.tools.map((tool) => tool.name);
		// Pi activates every registered extension tool before session_start runs.
		host.pi.setActiveTools([...catalog]);
		const tasks = startTaskControl({
			pi: host.pi,
			resources: { add: (): void => undefined },
		} as unknown as ExtensionLifecycleContext);
		expect(host.activeTools()).toEqual(catalog.filter((name) => !TASK_TOOL_IDS.includes(name)));
		expect(host.activeTools()).toEqual(expect.arrayContaining(["read", "bash", "python_eval"]));
		tasks.dispose();
	});

	test("activates apply_patch tool only when explicitly enabled", (): void => {
		const host = registeredTools();
		activatePatch(host, true);
		expect(host.activeTools()).toContain("apply_patch");
		activatePatch(host, false);
		expect(host.activeTools()).not.toContain("apply_patch");
	});

	test("activates python_eval only through its explicit static setting", (): void => {
		const host = registeredTools();
		activatePythonEvalCatalog(
			{
				pi: host.pi,
				resources: { add: (): void => undefined },
			} as unknown as ExtensionLifecycleContext,
			true,
		);
		expect(host.activeTools()).toContain("python_eval");
	});

	test("keeps narrow grep rows to one cell-width-safe line", (): void => {
		const host = registeredTools();
		const grep = toolFor(host.tools, "grep");
		const lines = grep
			.renderResult?.(
				{
					content: [{ type: "text", text: "long needle result" }],
					details: {
						format: "canonical-grep",
						engine: "rg",
						totalMatched: 1,
						totalFiles: 1,
						totalLines: 1,
						display: [
							{ type: "path", text: "src/long.ts" },
							{
								type: "match",
								lineNumber: 100,
								text: "needle followed by a long sentence",
								source: "prefix needle followed by a long sentence",
								visibleStart: 7,
								visibleEnd: 40,
								truncatedLeft: true,
								submatches: [{ start: 7, end: 13 }],
							},
						],
					},
				},
				{ isPartial: false, expanded: false },
				plainTheme,
				renderContext,
			)
			.render(10);
		if (lines === undefined) throw new Error("grep renderer is missing");
		const body = lines.filter((line) => !line.includes("─") && !line.includes(" · "));
		const plainBody = body.map(stripTerminalSequences);
		expect(plainBody).toContain(" 100 │ pr…");
		expect(plainBody.every((line) => visibleWidth(line) <= 10 && !line.includes("\n"))).toBe(true);
	});

	test("search renderers handle empty results", (): void => {
		const host = registeredTools();
		const find = toolFor(host.tools, "find");
		const findPlaceholder = find
			.renderResult?.(
				{
					content: [{ type: "text", text: "No files found matching pattern" }],
					details: undefined,
				},
				{ isPartial: false, expanded: false },
				roleTheme,
				renderContext,
			)
			.render(80);
		expect(findPlaceholder).toEqual([]);
	});

	test("hides pagination cursors from search renderers", (): void => {
		const host = registeredTools();
		const theme = {
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const grep = toolFor(host.tools, "grep");
		const find = toolFor(host.tools, "find");

		expect(
			grep
				.renderResult?.(
					{
						content: [{ type: "text", text: "src/a.ts\n1:needle" }],
						details: {
							format: "grep",
							engine: "rg",
							rows: [
								{ kind: "file", text: "src/a.ts" },
								{ kind: "match", text: "1: needle", ranges: [] },
							],
						},
					},
					{ isPartial: false, expanded: false },
					theme,
					renderContext,
				)
				.render(200)
				.join("\n"),
		).not.toContain("cursor:");
		expect(
			find
				.renderResult?.(
					{
						content: [{ type: "text", text: "1. src/a.ts (fuzzy)\ncursor: find:abc" }],
						details: undefined,
					},
					{ isPartial: false, expanded: false },
					theme,
					renderContext,
				)
				.render(200)
				.join("\n"),
		).not.toContain("cursor:");
	});

	test("exposes the upstream FFF grep and find schemas", (): void => {
		const host = registeredTools();
		const grep = toolFor(host.tools, "grep");
		const find = toolFor(host.tools, "find");
		const properties = (tool: ToolDefinition): string[] => {
			const schema: unknown = tool.parameters;
			if (
				typeof schema !== "object" ||
				schema === null ||
				!("properties" in schema) ||
				typeof schema.properties !== "object" ||
				schema.properties === null
			)
				throw new Error("Tool schema has no properties");
			return Object.keys(schema.properties);
		};
		expect(properties(grep)).toEqual([
			"pattern",
			"path",
			"glob",
			"ignoreCase",
			"literal",
			"context",
			"limit",
		]);
		const schema = grep.parameters as {
			readonly properties?: { readonly pattern?: { readonly description?: string } };
		};
		expect(schema.properties?.pattern?.description).toContain("after JSON decoding");
		expect(properties(find)).toEqual(["pattern", "path", "exclude", "limit", "cursor"]);
	});

	test("toggles apply_patch without modifying other active tools", (): void => {
		const host = registeredTools();
		activatePatch(host, true);
		expect(host.activeTools()).toContain("apply_patch");
		activatePatch(host, false);
		expect(host.activeTools()).not.toContain("apply_patch");
	});

	test("registers apply_patch as strict V4A patch transport", (): void => {
		const host = registeredTools();
		const applyPatch = toolFor(host.tools, "apply_patch");

		expect(applyPatch.parameters).toMatchObject({
			additionalProperties: false,
			required: ["patch"],
			properties: { patch: { type: "string" }, target: { type: "string" } },
		});
		const parameters: unknown = applyPatch.parameters;
		if (
			typeof parameters !== "object" ||
			parameters === null ||
			!("properties" in parameters) ||
			typeof parameters.properties !== "object" ||
			parameters.properties === null
		)
			throw new Error("apply_patch parameters are missing object properties");
		expect(Object.keys(parameters.properties)).toEqual(["patch", "target"]);
		expect("prepareArguments" in applyPatch).toBe(false);
	});

	test("renders canonical grep details and existing find results", (): void => {
		const host = registeredTools();
		const theme = {
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const grep = toolFor(host.tools, "grep");
		const find = toolFor(host.tools, "find");
		const grepResult = grep
			.renderResult?.(
				{
					content: [{ type: "text", text: `src/a.ts\n12: needle` }],
					details: {
						format: "canonical-grep",
						engine: "rg",
						totalMatched: 1,
						totalFiles: 1,
						totalLines: 3,
						display: [
							{ type: "text", text: "1 matches in 1 files" },
							{ type: "path", text: "src/a.ts" },
							{
								type: "context",
								lineNumber: 1,
								text: "before",
								source: "before",
								visibleStart: 0,
								visibleEnd: 6,
							},
							{
								type: "match",
								lineNumber: 12,
								text: "needle",
								source: "needle",
								visibleStart: 0,
								visibleEnd: 6,
								approximate: true,
								submatches: [{ start: 0, end: 6 }],
							},
							{
								type: "match",
								lineNumber: 13,
								text: "needle",
								source: "  needle trailing",
								visibleStart: 2,
								visibleEnd: 8,
								truncatedLeft: true,
								truncatedRight: true,
								submatches: [{ start: 2, end: 8 }],
							},
						],
					},
				},
				{ isPartial: false, expanded: false },
				theme,
				renderContext,
			)
			.render(200)
			.map((line) => line.trimEnd())
			.join("\n")
			.trimEnd();
		if (grepResult === undefined) throw new Error("grep renderer is missing");
		expect(grepResult).toContain("src/a.ts");
		expect(stripTerminalSequences(grepResult ?? "")).toContain("  1 │ before");
		expect(stripTerminalSequences(grepResult ?? "")).toContain(" 12 │ needle");
		expect(stripTerminalSequences(grepResult ?? "")).toContain(" 13 │   needle trailing");
		expect(grepResult).toContain("\x1b[2m");
		expect(grepResult).toContain("\x1b[48;2;18;42;28m");
		const collapsedResult = grep.renderResult?.(
			{
				content: [{ type: "text", text: "overflow" }],
				details: {
					format: "canonical-grep",
					engine: "rg",
					totalMatched: 20,
					totalFiles: 1,
					totalLines: 20,
					display: Array.from({ length: 21 }, (_, index) => ({
						type: "text" as const,
						text: `row ${index + 1}`,
					})),
				},
			},
			{ isPartial: false, expanded: false },
			theme,
			renderContext,
		);
		if (collapsedResult === undefined) throw new Error("grep renderer is missing");
		const collapsed = collapsedResult.render(200);
		expect(collapsed.length).toBeGreaterThan(0);
		const findResult = find
			.renderResult?.(
				{ content: [{ type: "text", text: "1. one.ts (fff_fuzzy)" }], details: undefined },
				{ isPartial: false, expanded: false },
				theme,
				renderContext,
			)
			.render(200)
			.join("\n")
			.trimEnd();
		expect(findResult).toContain("1. one.ts (fff_fuzzy)");
	});

	test("keeps grep match syntax bright and dims the rest of the line", (): void => {
		const host = registeredTools();
		const theme = {
			bg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const grep = toolFor(host.tools, "grep");
		if (grep === undefined) throw new Error("Missing grep tool");
		const result = grep
			.renderResult?.(
				{
					content: [{ type: "text", text: `notes.txt\n1: hello needle world` }],
					details: {
						format: "canonical-grep",
						engine: "rg",
						totalMatched: 1,
						totalFiles: 1,
						totalLines: 2,
						display: [
							{ type: "path", text: "notes.txt" },
							{
								type: "match",
								lineNumber: 1,
								text: "hello needle world",
								source: "hello needle world",
								submatches: [{ start: 6, end: 12 }],
								visibleStart: 0,
								visibleEnd: 18,
							},
						],
					},
				},
				{ isPartial: false, expanded: false },
				theme,
				renderContext,
			)
			.render(200)
			.join("\n");
		if (result === undefined) throw new Error("grep renderer is missing");
		const dim = "\x1b[2m";
		const reset = "\x1b[0m";
		const addBg = "\x1b[48;2;18;42;28m";
		expect(result).toContain(`${dim}hello `);
		expect(result).toContain(`${addBg}needle`);
		expect(result).toContain(`${dim} world`);
		expect(result).not.toContain(`${dim}needle`);
		expect(result.indexOf(`${dim}hello `)).toBeLessThan(result.indexOf(`${addBg}needle`));
		expect(result.indexOf(`${addBg}needle`)).toBeLessThan(result.indexOf(`${dim} world`));
		expect(result).toContain(reset);
	});

	test("keeps dim syntax after a highlighted grep match", (): void => {
		const host = registeredTools();
		const theme = {
			bg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const grep = toolFor(host.tools, "grep");
		if (grep === undefined) throw new Error("Missing grep tool");
		const source = "const needle = 1;";
		const result = grep
			.renderResult?.(
				{
					content: [{ type: "text", text: `a.ts\n1: ${source}` }],
					details: {
						format: "canonical-grep",
						engine: "rg",
						totalMatched: 1,
						totalFiles: 1,
						totalLines: 2,
						display: [
							{ type: "path", text: "a.ts" },
							{
								type: "match",
								lineNumber: 1,
								text: source,
								source,
								submatches: [{ start: 6, end: 12 }],
								visibleStart: 0,
								visibleEnd: source.length,
							},
						],
					},
				},
				{ isPartial: false, expanded: false },
				theme,
				renderContext,
			)
			.render(200)
			.join("\n");
		if (result === undefined) throw new Error("grep renderer is missing");
		const dim = "\x1b[2m";
		const needleAt = result.indexOf("needle");
		expect(needleAt).toBeGreaterThan(-1);
		expect(result.slice(0, needleAt)).toContain(dim);
		expect(result.slice(needleAt + "needle".length)).toContain(dim);
		expect(stripTerminalSequences(result)).toContain(source);
	});

	test("renders structured FFF find results inside the shared tool frame", (): void => {
		const host = registeredTools();
		const find = toolFor(host.tools, "find");
		if (find === undefined) throw new Error("Missing find tool");

		const result = find
			.renderResult?.(
				{
					content: [{ type: "text", text: "model-visible find output" }],
					details: {
						format: "canonical-find",
						candidates: [
							{ path: "src/a.ts", matchType: "fuzzy_filename" },
							{ path: "src/b.ts", matchType: "fuzzy_filename" },
							{ path: "docs/readme.md", matchType: "fuzzy_path" },
						],
						totalMatched: 30,
						totalFiles: 30,
					},
				},
				{ isPartial: false, expanded: false },
				taggedTheme,
				renderContext,
			)
			.render(80)
			.map((line) => line.trimEnd());
		if (result === undefined) throw new Error("Expected find result renderer");
		const joined = result.join("\n");
		expect(joined).toContain("fuzzy files:");
		expect(joined).toContain("src/");
		expect(joined).toContain("a.ts");
		expect(joined).toContain("fuzzy paths:");
		expect(joined).toContain("docs/readme.md");
	});

	test("executes read with the call context cwd instead of extension construction cwd", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "value.txt"), "canonical\n", "utf8");
		const host = registeredTools();
		const read = toolFor(host.tools, "read");

		const result = await read.execute("read-1", { path: "value.txt" }, undefined, undefined, {
			cwd,
		} as unknown as ExtensionToolContext);
		expect(result.content).toContainEqual({ type: "text", text: "canonical\n" });
		expect(result.details).toMatchObject({
			__piExtToolsRead: { characters: 10, lines: 2 },
		});
	});

	test("executes apply_patch through its strict V4A transport", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const host = registeredTools();
		const applyPatch = toolFor(host.tools, "apply_patch");

		const result = await applyPatch.execute(
			"apply-patch-1",
			{ patch: "*** Begin Patch\n*** Add File: created.txt\n+created\n*** End Patch" },
			undefined,
			undefined,
			{ cwd } as unknown as ExtensionToolContext,
		);
		expect(result.content).toContainEqual({
			type: "text",
			text: "Applied patch: 1 operations in 1 files.\nChanged:\n- created.txt: add",
		});
		expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("created\n");
	});

	test("reports rejected operation count rather than rejection group count", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const host = registeredTools();
		const applyPatch = toolFor(host.tools, "apply_patch");

		const result = await applyPatch.execute(
			"apply-patch-conflict",
			{
				patch:
					"*** Begin Patch\n" +
					"*** Add File: created.txt\n+created\n" +
					"*** Add File: first.txt\n+first\n" +
					"*** Add File: first.txt\n+second\n" +
					"*** End Patch",
			},
			undefined,
			undefined,
			{ cwd } as unknown as ExtensionToolContext,
		);
		expect(result.content).toContainEqual({
			type: "text",
			text: "Patch partially applied.\nChanged:\n- created.txt: add\nRejected:\n- operation 2, operation 3, first.txt: path touched more than once: first.txt\nRecovery: read first.txt, then retry only operation 2, operation 3.\nDo not retry applied operations.",
		});
		expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("created\n");
		await expect(readFile(join(cwd, "first.txt"), "utf8")).rejects.toThrow();
	});

	test("publishes successful hunks when another hunk fails", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "value.txt"), "one\ntwo\nthree\nfour\nfive\n", "utf8");
		const host = registeredTools();
		const applyPatch = toolFor(host.tools, "apply_patch");

		const result = await applyPatch.execute(
			"apply-patch-partial-hunks",
			{
				patch:
					"*** Begin Patch\n" +
					"*** Update File: value.txt\n" +
					"@@\n-one\n+ONE\n" +
					"@@\n-missing\n+MISS\n" +
					"@@\n-five\n+FIVE\n" +
					"*** End Patch",
			},
			undefined,
			undefined,
			{ cwd } as unknown as ExtensionToolContext,
		);

		expect(result.details).toMatchObject({
			status: "partial",
			operations: [{ status: "partial", appliedHunks: 2, totalHunks: 3 }],
		});
		expect(result.content).toContainEqual({
			type: "text",
			text:
				"Patch partially applied.\n" +
				"Changed:\n" +
				"- value.txt: update (2/3 hunks applied)\n" +
				"Rejected:\n" +
				"- operation 1, value.txt, hunk 2: context not found\n" +
				"Recovery: read value.txt, then retry only rejected hunks from operation 1.\n" +
				"Do not retry applied hunks.",
		});
		expect(await readFile(join(cwd, "value.txt"), "utf8")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
	});

	test("keeps custom write/edit views when the existing file exceeds the highlight budget", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const huge = `HEAD\n${"x".repeat(MAX_HL_CHARS)}\n`;
		await writeFile(join(cwd, "huge.txt"), huge, "utf8");
		const host = registeredTools();
		const context = {
			cwd,
			sessionManager: {
				getSessionId: (): string => "ext-tools-test",
				getSessionFile: (): undefined => undefined,
			},
		} as unknown as ExtensionToolContext;
		const write = toolFor(host.tools, "write");
		const edit = toolFor(host.tools, "edit");

		const written = await write.execute(
			"write-huge",
			{ path: "huge.txt", content: "small\n" },
			undefined,
			undefined,
			context,
		);
		const writeView = (written.details as Record<string, unknown>).__piExtToolsWriteView as
			| { kind?: string; content?: string; lines?: number }
			| undefined;
		expect(writeView).toEqual({
			kind: "replace",
			lines: 1,
			language: undefined,
		});
		await writeFile(join(cwd, "huge.txt"), huge, "utf8");
		const edited = await edit.execute(
			"edit-huge",
			{ path: "huge.txt", edits: [{ oldText: "HEAD", newText: "TAIL" }] },
			undefined,
			undefined,
			context,
		);
		const editView = (edited.details as Record<string, unknown>).__piExtToolsEditView as
			| { op?: { oldContent?: string; newContent?: string } }
			| undefined;
		expect(editView?.op).toEqual({
			oldContent: "HEAD",
			newContent: "TAIL",
			editLine: 0,
			startLine: 0,
		});
	});

	test("preserves upstream write and edit execution semantics", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const host = registeredTools();
		const context = {
			cwd,
			sessionManager: {
				getSessionId: (): string => "ext-tools-test",
				getSessionFile: (): undefined => undefined,
			},
		} as unknown as ExtensionToolContext;
		const write = toolFor(host.tools, "write");
		const edit = toolFor(host.tools, "edit");

		await write.execute(
			"write-1",
			{ path: "value.txt", content: "before\n" },
			undefined,
			undefined,
			context,
		);
		await edit.execute(
			"edit-1",
			{ path: "value.txt", edits: [{ oldText: "before", newText: "after" }] },
			undefined,
			undefined,
			context,
		);
		expect(await readFile(join(cwd, "value.txt"), "utf8")).toBe("after\n");
	});
});
