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
	test("registers each approved name exactly once through managed Loadout ownership", (): void => {
		const host = harness();
		registerTools(host.pi);
		const names = host.tools.map((tool) => tool.name);
		expect(names).toEqual([
			"read",
			"grep",
			"find",
			"edit",
			"write",
			"bash",
			"bash_job",
			"apply_patch",
		]);
		expect(names.filter((name) => name === "apply_patch")).toHaveLength(1);
		expect(host.tools.every((tool) => tool.renderShell === "self")).toBe(true);
		expect(() => registerTools(host.pi)).toThrow("Loadout tool id already registered: read");
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
		expect(preview).toContain("<dim>  │...</dim>");
		expect(preview).toContain("<dim>55│</dim>T1");
		expect(preview).toContain("<dim>56│</dim>T2");
		expect(preview).toContain("<dim>315 chars · 48 lines · 10ms</dim>");
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
		expect(narrow).toContain("<dim>></dim>");
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

	test("registers Built-in provenance and bidirectional mutator locks", (): void => {
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
			conflictsWith: ["edit", "write"],
		});
		expect(inventory.find((tool) => tool.id === "edit")).toMatchObject({
			group: "Built-in",
			origin: "@hheei/pi-ext-tools",
			conflictsWith: ["apply_patch"],
		});
		expect(inventory.find((tool) => tool.id === "write")).toMatchObject({
			group: "Built-in",
			origin: "@hheei/pi-ext-tools",
			conflictsWith: ["apply_patch"],
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
		registerTools(host.pi);
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
			"<warning>◐</warning> <accent>grep</accent> <mdCode>/needle/</mdCode> in <dim>src</dim>",
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
		expect(grepResult).toContain("<dim> 1│</dim>before");
		expect(grepResult).toContain("<dim>13│</dim><dim><</dim><success>needle</success><dim>></dim>");
		expect(grepResult).not.toContain("1 matches in 1 files");
		expect(grepResult).toContain("<dim>1 matches · 1 files · 3.7s</dim>");
		const collapsedResult = grep.renderResult?.(
			{
				content: [{ type: "text", text: "overflow" }],
				details: {
					format: "canonical-grep",
					engine: "rg",
					totalMatched: 20,
					totalFiles: 1,
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
		expect(collapsed.at(-3)).toContain("... (9 more lines, expand to show)");
		expect(collapsed.at(-1)).toContain("20 matches · 1 files · 0ms");
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
		expect(findResult).toContain("<success>FF</success> <dim>one.ts</dim>");
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

	test("preserves upstream write and edit execution semantics", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const host = harness();
		registerTools(host.pi);
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
