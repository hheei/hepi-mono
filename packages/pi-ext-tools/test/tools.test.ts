import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { observeLoadoutInventory } from "@hheei/pi-ext-core";
import { registerTools } from "../src/tools.js";

const temporaryPaths: string[] = [];
const renderContext = { isError: false, isPartial: false, lastComponent: undefined } as never;
const renderCallContext = { isError: false, isPartial: true, lastComponent: undefined } as never;

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hepi-ext-tools-"));
	temporaryPaths.push(path);
	return path;
}

function harness(): { readonly pi: ExtensionAPI; readonly tools: ToolDefinition[] } {
	const tools: ToolDefinition[] = [];
	return {
		pi: {
			events: {},
			registerTool: (tool: ToolDefinition): void => {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI,
		tools,
	};
}

describe("pi-ext-tools catalog", () => {
	test("registers the apply_patch editing catalog by default through managed Loadout ownership", (): void => {
		const host = harness();
		registerTools(host.pi);
		const names = host.tools.map((tool) => tool.name);
		expect(names).toEqual(["read", "grep", "find", "bash", "bash_job", "apply_patch"]);
		expect(names.filter((name) => name === "apply_patch")).toHaveLength(1);
		expect(host.tools.every((tool) => tool.renderShell === "self")).toBe(true);
		expect(() => registerTools(host.pi)).toThrow("Loadout tool id already registered: read");
	});

	test("registers exactly the editing tools selected by Edit Mode", (): void => {
		const native = harness();
		registerTools(native.pi, undefined, undefined, "native");
		expect(native.tools.map((tool) => tool.name)).toContain("edit");
		expect(native.tools.map((tool) => tool.name)).toContain("write");
		expect(native.tools.map((tool) => tool.name)).not.toContain("apply_patch");

		const none = harness();
		registerTools(none.pi, undefined, undefined, "none");
		expect(none.tools.map((tool) => tool.name)).not.toContain("edit");
		expect(none.tools.map((tool) => tool.name)).not.toContain("write");
		expect(none.tools.map((tool) => tool.name)).not.toContain("apply_patch");
		expect(none.tools.map((tool) => tool.name)).toEqual([
			"read",
			"grep",
			"find",
			"bash",
			"bash_job",
		]);
	});

	test("renders a bounded, numbered read preview without changing model content", (): void => {
		const host = harness();
		registerTools(host.pi);
		const read = host.tools.find((tool) => tool.name === "read");
		if (read === undefined) throw new Error("read was not registered");
		const theme = {
			bg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => `<b>${text}</b>`,
		} as Theme;
		const source = [
			"H1",
			"H2",
			"H3",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"hidden",
			"T1",
			"T2",
		].join("\n");
		const result = {
			content: [{ type: "text" as const, text: source }],
			details: { __piExtToolsCompletion: { durationMs: 10 } },
		};
		const call = read.renderCall?.(
			{ path: "sample.ts", offset: 9, limit: 48 },
			theme,
			renderContext,
		);
		expect(call?.render(200)).toEqual([
			"<success>✓</success> <toolTitle><b>read</b></toolTitle> sample.ts<warning>:9-56</warning>",
		]);
		const preview = read
			.renderResult?.(result, { isPartial: false, expanded: false }, theme, {
				...(renderContext as object),
				args: { path: "sample.ts", offset: 9, limit: 48 },
			} as never)
			?.render(80)
			.join("\n");
		expect(preview).toContain("<dim> 9│</dim>H1");
		expect(preview).toContain("<dim>10│</dim>H2");
		expect(preview).toContain("<dim>… (43 hidden lines, ctrl+o to expand)</dim>");
		expect(preview).toContain("<dim>55│</dim>T1");
		expect(preview).toContain("<dim>56│</dim>T2");
		expect(preview).not.toContain("315 chars · 48 lines · 10ms");
		expect(result.content[0]?.text).toBe(source);
		const expanded = read
			.renderResult?.(result, { isPartial: false, expanded: true }, theme, {
				...(renderContext as object),
				args: { path: "sample.ts", offset: 9, limit: 48 },
			} as never)
			?.render(200)
			.join("\n");
		expect(expanded).toContain("hidden");
		expect(result.content[0]?.text).toBe(source);
		const narrow = read
			.renderResult?.(
				{ ...result, content: [{ type: "text" as const, text: "12345678901234567890" }] },
				{ isPartial: false, expanded: false },
				theme,
				{ ...(renderContext as object), args: { path: "sample.ts" } } as never,
			)
			?.render(10)
			.join("\n");
		expect(stripTerminalSequences(narrow ?? "")).toContain("…");
	});

	test("omits read body rails when the visible preview has no lines", (): void => {
		const host = harness();
		registerTools(host.pi);
		const read = host.tools.find((tool) => tool.name === "read");
		if (read === undefined) throw new Error("read was not registered");
		const theme = {
			bg: (_role: string, text: string): string => text,
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const lines = read
			.renderResult?.(
				{
					content: [{ type: "text", text: "\n" }],
					details: { __piExtToolsRead: { characters: 1, lines: 2 } },
				},
				{ isPartial: false, expanded: false },
				theme,
				{ ...(renderContext as object), args: { path: "empty.ts" } } as never,
			)
			.render(80);
		expect(lines).toEqual(["<dim>1 chars · 2 lines · 0ms</dim>"]);
	});

	test("hides read continuation instructions without changing model content", (): void => {
		const host = harness();
		registerTools(host.pi);
		const read = host.tools.find((tool) => tool.name === "read");
		if (read === undefined) throw new Error("read was not registered");
		const theme = {
			bg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => `<b>${text}</b>`,
		} as Theme;
		const source = "first\nsecond\n\n[17 more lines in file. Use offset=310 to continue.]";
		const result = { content: [{ type: "text" as const, text: source }], details: undefined };
		const context = { ...(renderContext as object), args: { path: "sample.ts" } } as never;
		const collapsed = read
			.renderResult?.(result, { isPartial: false, expanded: false }, theme, context)
			.render(120)
			.join("\n");
		const expanded = read
			.renderResult?.(result, { isPartial: false, expanded: true }, theme, context)
			.render(120)
			.join("\n");
		expect(collapsed).not.toContain("Use offset=310 to continue.");
		expect(expanded).not.toContain("Use offset=310 to continue.");
		expect(result.content[0]?.text).toBe(source);
	});

	test("keeps narrow read rows to one cell-width-safe line", (): void => {
		const host = harness();
		registerTools(host.pi);
		const read = host.tools.find((tool) => tool.name === "read");
		if (read === undefined) throw new Error("read was not registered");
		const plainTheme = {
			bg: (_role: string, text: string): string => text,
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		} as Theme;
		const lines = read
			.renderResult?.(
				{
					content: [{ type: "text", text: "abcdefghijklmnopqrstuvwxyz" }],
					details: undefined,
				},
				{ isPartial: false, expanded: false },
				plainTheme,
				{ ...(renderContext as object), args: { path: "sample.ts", offset: 100 } } as never,
			)
			.render(6);
		if (lines === undefined) throw new Error("read renderer is missing");
		const body = lines.filter((line) => !line.includes("─") && !line.includes("completed"));
		const plainBody = body.map(stripTerminalSequences);
		expect(plainBody).toEqual(["100│a…"]);
		expect(plainBody.every((line) => visibleWidth(line) <= 6 && !line.includes("\n"))).toBe(true);
	});

	test("omits search body rails when there are no body lines", (): void => {
		const host = harness();
		registerTools(host.pi);
		const grep = host.tools.find((tool) => tool.name === "grep");
		const find = host.tools.find((tool) => tool.name === "find");
		if (grep === undefined || find === undefined) throw new Error("Missing search tools");
		const theme = {
			bg: (_role: string, text: string): string => text,
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const grepLines = grep
			.renderResult?.(
				{
					content: [{ type: "text", text: "" }],
					details: {
						format: "canonical-grep",
						engine: "rg",
						totalMatched: 0,
						totalFiles: 0,
						totalLines: 0,
						durationMs: 5,
						display: [],
					},
				},
				{ isPartial: false, expanded: false },
				theme,
				renderContext,
			)
			.render(80);
		expect(grepLines).toEqual(["<dim>0 matches · 0 files · 0 lines · 5ms</dim>"]);

		const findLines = find
			.renderResult?.(
				{
					content: [{ type: "text", text: "" }],
					details: {
						format: "canonical-find",
						candidates: [],
						totalMatched: 0,
						totalFiles: 0,
						durationMs: 5,
					},
				},
				{ isPartial: false, expanded: false },
				theme,
				renderContext,
			)
			.render(80);
		expect(findLines).toEqual(["<dim>0 lines · 5ms</dim>"]);
	});

	test("hides pagination cursors from search renderers", (): void => {
		const host = harness();
		registerTools(host.pi);
		const theme = {
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const grep = host.tools.find((candidate) => candidate.name === "grep");
		const find = host.tools.find((candidate) => candidate.name === "find");
		if (grep === undefined || find === undefined) throw new Error("Missing search tools");

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
		const host = harness();
		registerTools(host.pi);
		const grep = host.tools.find((tool) => tool.name === "grep");
		const find = host.tools.find((tool) => tool.name === "find");
		if (grep === undefined || find === undefined) throw new Error("Missing FFF search tools");
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
		expect(properties(find)).toEqual(["pattern", "path", "exclude", "limit", "cursor"]);
	});

	test("registers Built-in provenance for the selected mutator catalog", (): void => {
		const host = harness();
		const controller = new AbortController();
		let inventory: readonly {
			readonly id: string;
			readonly group: string;
			readonly origin?: string;
			readonly conflictsWith?: readonly string[];
		}[] = [];
		observeLoadoutInventory(host.pi, {
			signal: controller.signal,
			onChange(items) {
				inventory = items;
			},
		});

		registerTools(host.pi);
		expect(inventory.find((tool) => tool.id === "apply_patch")).toMatchObject({
			group: "Built-in",
			origin: "@hheei/pi-ext-tools",
		});
		expect(inventory.find((tool) => tool.id === "edit")).toBeUndefined();
		expect(inventory.find((tool) => tool.id === "write")).toBeUndefined();
		expect(inventory.every((tool) => tool.group === "Built-in")).toBe(true);
		controller.abort();
	});

	test("registers native edit and write with Built-in provenance", (): void => {
		const host = harness();
		const controller = new AbortController();
		let inventory: readonly {
			readonly id: string;
			readonly group: string;
			readonly origin?: string;
		}[] = [];
		observeLoadoutInventory(host.pi, {
			signal: controller.signal,
			onChange(items) {
				inventory = items;
			},
		});

		registerTools(host.pi, undefined, undefined, "native");
		expect(inventory.find((tool) => tool.id === "apply_patch")).toBeUndefined();
		expect(inventory.find((tool) => tool.id === "edit")).toMatchObject({
			group: "Built-in",
			origin: "@hheei/pi-ext-tools",
		});
		expect(inventory.find((tool) => tool.id === "write")).toMatchObject({
			group: "Built-in",
			origin: "@hheei/pi-ext-tools",
		});
		expect(inventory.every((tool) => tool.group === "Built-in")).toBe(true);
		controller.abort();
	});

	test("registers apply_patch as strict V4A patch transport", (): void => {
		const host = harness();
		registerTools(host.pi);
		const applyPatch = host.tools.find((tool) => tool.name === "apply_patch");
		if (applyPatch === undefined) throw new Error("apply_patch was not registered");

		expect(applyPatch.parameters).toMatchObject({
			additionalProperties: false,
			required: ["patch"],
			properties: { patch: { type: "string" } },
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
		expect(Object.keys(parameters.properties)).toEqual(["patch"]);
		expect("prepareArguments" in applyPatch).toBe(false);
	});

	test("keeps upstream renderer contracts intact", (): void => {
		const host = harness();
		registerTools(host.pi, undefined, undefined, "native");
		for (const name of ["read", "grep", "find", "edit", "write", "bash"] as const) {
			const tool = host.tools.find((candidate) => candidate.name === name);
			if (tool === undefined) throw new Error(`Missing ${name} tool`);
			expect(tool.renderShell).toBe("self");
			expect(tool.renderCall).toBeDefined();
			expect(tool.renderResult).toBeDefined();
		}
	});

	test("renders canonical grep details and existing find results", (): void => {
		const host = harness();
		registerTools(host.pi);
		const theme = {
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const grep = host.tools.find((candidate) => candidate.name === "grep");
		const find = host.tools.find((candidate) => candidate.name === "find");
		if (grep === undefined || find === undefined) throw new Error("Missing search tool");
		const grepCall = grep
			.renderCall?.({ pattern: "needle", path: "src" }, theme, renderCallContext)
			.render(200)
			.join("\n")
			.trimEnd();
		expect(grepCall).toBe(
			"<warning>◐</warning> <toolTitle>grep</toolTitle> <mdCode>/needle/</mdCode> in <dim>src</dim>",
		);
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
						durationMs: 3_700,
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
		expect(grepResult).toContain("<mdCode>src/a.ts</mdCode>");
		expect(grepResult).toContain("<dim> 1│</dim><dim>before</dim>");
		expect(grepResult).toContain("<dim>13│</dim><dim>…</dim><success>needle</success><dim>…</dim>");
		expect(grepResult).not.toContain("1 matches in 1 files");
		expect(grepResult).toContain("<dim>1 matches · 1 files · 3 lines · 3.7s</dim>");
		const collapsedResult = grep.renderResult?.(
			{
				content: [{ type: "text", text: "overflow" }],
				details: {
					format: "canonical-grep",
					engine: "rg",
					totalMatched: 20,
					totalFiles: 1,
					totalLines: 20,
					durationMs: 0,
					display: Array.from({ length: 20 }, (_, index) => ({
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
		expect(collapsed).toHaveLength(15);
		expect(collapsed.at(-3)).toContain("… (9 more lines, expand to show)");
		expect(collapsed.at(-1)).toContain("20 matches · 1 files · 20 lines · 0ms");
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

	test("renders structured FFF find results inside the shared tool frame", (): void => {
		const host = harness();
		registerTools(host.pi);
		const theme = {
			bg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => `<b>${text}</b>`,
		} as Theme;
		const find = host.tools.find((candidate) => candidate.name === "find");
		if (find === undefined) throw new Error("Missing find tool");
		const header = find
			.renderCall?.({ pattern: "needle", path: "src" }, theme, renderCallContext)
			.render(120)
			.join("\n")
			.trimEnd();
		expect(header).toBe(
			"<warning>◐</warning> <toolTitle><b>find</b></toolTitle> <mdCode>/needle/</mdCode> in <dim>src</dim>",
		);

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
						durationMs: 20,
					},
				},
				{ isPartial: false, expanded: false },
				theme,
				renderContext,
			)
			.render(80)
			.map((line) => line.trimEnd());
		expect(result.filter((line) => line.includes("─"))).toHaveLength(2);
		expect(result).toContain("fuzzy files:");
		expect(result).toContain("<mdCode>src/</mdCode>");
		expect(result).toContain("a.ts");
		expect(result).toContain("fuzzy paths:");
		expect(result).toContain("docs/readme.md");
		expect(result).toContain("<dim>2 fuzzy files · 1 fuzzy paths · 7 lines · 20ms</dim>");
		expect(result.join("\n")).not.toContain("model-visible find output");
	});

	test("executes read with the call context cwd instead of extension construction cwd", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "value.txt"), "canonical\n", "utf8");
		const host = harness();
		registerTools(host.pi);
		const read = host.tools.find((tool) => tool.name === "read");
		if (read === undefined) throw new Error("read was not registered");

		const result = await read.execute("read-1", { path: "value.txt" }, undefined, undefined, {
			cwd,
		} as ExtensionContext);
		expect(result.content).toContainEqual({ type: "text", text: "canonical\n" });
		expect(result.details).toMatchObject({
			__piExtToolsRead: { characters: 10, lines: 2 },
			__piExtToolsCompletion: { durationMs: expect.any(Number) },
		});
	});

	test("executes apply_patch through its strict V4A transport", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const host = harness();
		registerTools(host.pi);
		const applyPatch = host.tools.find((tool) => tool.name === "apply_patch");
		if (applyPatch === undefined) throw new Error("apply_patch was not registered");

		const result = await applyPatch.execute(
			"apply-patch-1",
			{ patch: "*** Begin Patch\n*** Add File: created.txt\n+created\n*** End Patch" },
			undefined,
			undefined,
			{ cwd } as ExtensionContext,
		);
		expect(result.content).toContainEqual({
			type: "text",
			text: "Applied patch: 1 operations in 1 files.\nChanged:\n- created.txt: add",
		});
		expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("created\n");
	});

	test("reports rejected operation count rather than rejection group count", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const host = harness();
		registerTools(host.pi);
		const applyPatch = host.tools.find((tool) => tool.name === "apply_patch");
		if (applyPatch === undefined) throw new Error("apply_patch was not registered");

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
			{ cwd } as ExtensionContext,
		);
		expect(result.content).toContainEqual({
			type: "text",
			text: "Patch partially applied.\nChanged:\n- created.txt: add\nRejected:\n- operation 2, operation 3, first.txt: path touched more than once: first.txt\nRecovery: read first.txt, then retry only operation 2, operation 3.\nDo not retry applied operations.",
		});
		expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("created\n");
		await expect(readFile(join(cwd, "first.txt"), "utf8")).rejects.toThrow();
	});

	test("reports only rejected hunks after a partially applied update", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "value.txt"), "one\ntwo\nthree\nfour\nfive\n", "utf8");
		const host = harness();
		registerTools(host.pi);
		const applyPatch = host.tools.find((tool) => tool.name === "apply_patch");
		if (applyPatch === undefined) throw new Error("apply_patch was not registered");

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
			{ cwd } as ExtensionContext,
		);

		expect(result.details).toMatchObject({ status: "partial" });
		expect(result.content).toContainEqual({
			type: "text",
			text: "Patch partially applied.\nChanged:\n- value.txt: update (2/3 hunks applied)\nRejected:\n- operation 1, value.txt, hunk 2: best fuzzy score 0.00 < required 0.70\nRecovery: read value.txt, then retry only rejected hunks from operation 1.\nDo not retry applied hunks.",
		});
		expect(await readFile(join(cwd, "value.txt"), "utf8")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
	});

	test("preserves upstream write and edit execution semantics", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const host = harness();
		registerTools(host.pi, undefined, undefined, "native");
		const context = {
			cwd,
			sessionManager: {
				getSessionId: (): string => "ext-tools-test",
				getSessionFile: (): undefined => undefined,
			},
		} as unknown as ExtensionContext;
		const write = host.tools.find((tool) => tool.name === "write");
		const edit = host.tools.find((tool) => tool.name === "edit");
		if (write === undefined || edit === undefined)
			throw new Error("catalog tool was not registered");

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
