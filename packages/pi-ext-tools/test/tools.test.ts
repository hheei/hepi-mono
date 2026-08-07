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
import { normalizeNativeGrepResult } from "../src/grep-format.js";
import { registerTools } from "../src/tools.js";

const temporaryPaths: string[] = [];
const renderContext = { isError: false, lastComponent: undefined } as never;
const renderCallContext = { lastComponent: undefined } as never;

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
		expect(() => registerTools(host.pi)).toThrow("Loadout tool id already registered: read");
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
						content: [{ type: "text", text: "src/a.ts\n1:needle\ncursor: grep:abc" }],
						details: { format: "fff-grep" },
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
			"exclude",
			"caseSensitive",
			"context",
			"limit",
			"cursor",
		]);
		expect(properties(find)).toEqual(["pattern", "path", "exclude", "limit", "cursor"]);
	});

	test("normalizes native grep output to the FFF result shape", (): void => {
		const result = normalizeNativeGrepResult({
			content: [
				{
					type: "text",
					text: "src/a.ts:10: first\nsrc/a.ts-9- before\nsrc/b.ts:3: second",
				},
			],
			details: undefined,
		});
		expect(result.content[0]?.text).toBe(
			"Found 2 matches in 2 files.\n\nsrc/a.ts\n10:first\n9│before\n\nsrc/b.ts\n3:second",
		);
		expect(result.details).toMatchObject({
			format: "fff-grep",
			totalMatched: 2,
			totalFiles: 2,
		});
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
		for (const [name, renderShell] of [
			["read", undefined],
			["grep", undefined],
			["find", undefined],
			["edit", "self"],
			["write", undefined],
			["bash", undefined],
		] as const) {
			const tool = host.tools.find((candidate) => candidate.name === name);
			if (tool === undefined) throw new Error(`Missing ${name} tool`);
			expect(tool.renderShell).toBe(renderShell);
			expect(tool.renderCall).toBeDefined();
			expect(tool.renderResult).toBeDefined();
		}
	});

	test("uses pi-fff grep and find display formatting", (): void => {
		const host = harness();
		registerTools(host.pi);
		const theme = {
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const grep = host.tools.find((candidate) => candidate.name === "grep");
		const find = host.tools.find((candidate) => candidate.name === "find");
		if (grep === undefined || find === undefined) throw new Error("Missing search tool");

		expect(
			grep
				.renderCall?.({ pattern: "needle", path: "src", timeout: 5 }, theme, renderCallContext)
				.render(200)
				.join("\n")
				.trimEnd(),
		).toBe(
			"<accent>grep</accent> <mdCode>/needle/</mdCode> in <dim>src</dim><dim> (timeout 5s)</dim>",
		);
		expect(
			find
				.renderCall?.({ pattern: "status-surface", limit: 8 }, theme, renderCallContext)
				.render(200)
				.join("\n")
				.trimEnd(),
		).toBe("<accent>find</accent> <mdCode>status-surface</mdCode> (limit 8)");
		expect(
			grep
				.renderResult?.(
					{
						content: [{ type: "text", text: "src/a.ts (2 matches)\nline: 1, 3, ..." }],
						details: { format: "fff-grep" },
					},
					{ isPartial: false, expanded: false },
					theme,
					renderContext,
				)
				.render(200)
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd(),
		).toBe("<dim>src/a.ts</dim> (<success>2</success> matches)\n<dim>line: 1, 3, ...</dim>");
		expect(
			grep
				.renderResult?.(
					{
						content: [
							{
								type: "text",
								text: "src/\na.ts:1,2,3,4,5,6 (6 matches)\nb.ts:7 (1 matches)",
							},
						],
						details: { format: "fff-grep" },
					},
					{ isPartial: false, expanded: false },
					theme,
					renderContext,
				)
				.render(200)
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd(),
		).toBe(
			"<mdCode>src/</mdCode>\n<dim>a.ts</dim><warning>:1,2,3,4,5, …</warning> (<success>6</success> matches)\n<dim>b.ts</dim><warning>:7</warning> (<success>1</success> matches)",
		);
		expect(
			grep
				.renderResult?.(
					{
						content: [
							{
								type: "text",
								text: "Found 9 matches in 3 files.\n\n\nsrc/a.ts\n1:one",
							},
						],
						details: { format: "fff-grep" },
					},
					{ isPartial: false, expanded: false },
					theme,
					renderContext,
				)
				.render(200)
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd(),
		).toBe(
			"Found <success>9</success> matches in <success>3</success> files.\n\n<mdCode>src/a.ts</mdCode>\n<dim>1:</dim>one",
		);
		expect(
			grep
				.renderResult?.(
					{
						content: [
							{
								type: "text",
								text: "0 exact matches. 3 approximate:\nsrc/a.ts\n1?one\n100?hundred\nother/b.ts\n2?two",
							},
						],
						details: { format: "fff-grep" },
					},
					{ isPartial: false, expanded: false },
					theme,
					renderContext,
				)
				.render(200)
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd(),
		).toBe(
			"<mdCode>0 exact matches. 3 approximate:</mdCode>\n<mdCode>src/a.ts</mdCode>\n<dim>  1?</dim>one\n<dim>100?</dim>hundred\n<mdCode>other/b.ts</mdCode>\n<dim>2?</dim>two",
		);
		expect(
			find
				.renderResult?.(
					{
						content: [
							{
								type: "text",
								text: "src/\n1. search.ts (fff)\n8. historian-orchestrator.ts (fuzzy_filename) git:modified\n9. historian-branch-runner.ts (fuzzy_filename) git:modified\n10. historian-executor.ts (ffp)",
							},
						],
						details: undefined,
					},
					{ isPartial: false, expanded: false },
					theme,
					renderContext,
				)
				.render(200)
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd(),
		).toBe(
			"<mdCode>src/</mdCode>\n<success>FF</success> <dim>search.ts</dim>\n<success>FF</success> <dim>historian-orchestrator.ts</dim> (git:modified)\n<success>FF</success> <dim>historian-branch-runner.ts</dim> (git:modified)\n<success>FP</success> <dim>historian-executor.ts</dim>",
		);
		expect(
			grep
				.renderResult?.(
					{
						content: [{ type: "text", text: "src/a.ts\n9:one\n100:hundred" }],
						details: { format: "fff-grep" },
					},
					{ isPartial: false, expanded: false },
					theme,
					renderContext,
				)
				.render(200)
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd(),
		).toBe("<mdCode>src/a.ts</mdCode>\n<dim>  9:</dim>one\n<dim>100:</dim>hundred");
		expect(
			grep
				.renderResult?.(
					{
						content: [{ type: "text", text: "src/a.ts\n1:one\n6│context\n\n29│context\n30:two" }],
						details: { format: "fff-grep" },
					},
					{},
					theme,
					{ isError: false, lastComponent: undefined },
				)
				.render(200)
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd(),
		).toBe(
			"<mdCode>src/a.ts</mdCode>\n<dim> 1:</dim>one\n<dim> 6│</dim>context\n\n<dim>29│</dim>context\n<dim>30:</dim>two",
		);
		expect(
			grep
				.renderResult?.(
					{
						content: [
							{ type: "text", text: "src/a.ts\n9│before\n10:match\n\nsrc/b.ts\n100:later" },
						],
						details: undefined,
					},
					{},
					theme,
					{ isError: false, lastComponent: undefined },
				)
				.render(200)
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd(),
		).toBe(
			"Found 3 matches in 2 files.\n\n<mdCode>src/a.ts</mdCode>\n<dim> 9│</dim>before\n<dim>10:</dim>match\n\n<mdCode>src/b.ts</mdCode>\n<dim>100:</dim>later",
		);
		expect(
			find
				.renderResult?.(
					{
						content: [
							{
								type: "text",
								text: "src/\n1. one.ts (fuzzy) - frequent git:modified\n2. two.ts (prefix)",
							},
						],
						details: undefined,
					},
					{ isPartial: false, expanded: false },
					theme,
					renderContext,
				)
				.render(200)
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd(),
		).toBe(
			"<mdCode>src/</mdCode>\n<success>FF</success> <dim>one.ts</dim> (frequent git:modified)\n<success>FP</success> <dim>two.ts</dim>",
		);
		expect(
			find
				.renderResult?.(
					{
						content: [{ type: "text", text: "1. one.ts (fff_fuzzy)\n2. two.ts (fff_prefix)" }],
						details: undefined,
					},
					{ isPartial: false, expanded: false },
					theme,
					renderContext,
				)
				.render(200)
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd(),
		).toBe("<success>FF</success> <dim>one.ts</dim>\n<success>FP</success> <dim>two.ts</dim>");
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
			text: "Done! Applied patch.\nStatus: Success\nFiles changed: 1\nOperations: 1\nExact updates: 0\nFuzzy updates: 0\nFuzzy matching: not used\nRejected operations: 0",
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
			text: "Applied patch partially.\nStatus: Partial\nFiles changed: 1\nOperations: 3\nExact updates: 0\nFuzzy updates: 0\nFuzzy matching: not used\nRejected operations: 2\nRejected paths: first.txt\nReason: path touched more than once: first.txt",
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
