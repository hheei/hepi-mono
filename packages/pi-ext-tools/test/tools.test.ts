import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
	type Theme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	createToolTui,
	type ExtensionLifecycleContext,
	observeLoadoutInventory,
} from "@hheei/pi-ext-core";
import { afterEach, describe, expect, test } from "vitest";
import type { EditCatalog } from "../src/fff/settings.js";
import { MAX_HL_CHARS } from "../src/pretty/config.js";
import { activateEditCatalog, activateEvalCatalog, registerTools } from "../src/tools.js";

const temporaryPaths: string[] = [];
const renderContext = { isError: false, isPartial: false, lastComponent: undefined } as never;
const renderCallContext = { isError: false, isPartial: true, lastComponent: undefined } as never;
const renderCallContextValues = { isError: false, isPartial: true, lastComponent: undefined };

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

function harness(): {
	readonly pi: ExtensionAPI;
	readonly tools: ToolDefinition[];
	readonly activeTools: () => readonly string[];
} {
	const tools: ToolDefinition[] = [];
	let activeTools = ["read", "bash", "edit", "write"];
	return {
		pi: {
			events: {},
			on: (): void => {},
			registerTool: (tool: ToolDefinition): void => {
				tools.push(tool);
			},
			getActiveTools: (): readonly string[] => activeTools,
			setActiveTools: (names: string[]): void => {
				activeTools = names;
			},
		} as unknown as ExtensionAPI,
		tools,
		activeTools: () => activeTools,
	};
}

function activate(host: ReturnType<typeof harness>, catalog: EditCatalog): void {
	activateEditCatalog(
		{
			pi: host.pi,
			resources: { add: (): void => undefined },
		} as unknown as ExtensionLifecycleContext,
		catalog,
	);
}

describe("pi-ext-tools catalog", () => {
	test("registers every canonical editing definition before catalog activation", (): void => {
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
			"eval",
		]);
		expect(names.filter((name) => name === "apply_patch")).toHaveLength(1);
		expect(host.tools.find((tool) => tool.name === "edit")?.renderShell).toBe("self");
		expect(host.tools.every((tool) => tool.renderShell === "self")).toBe(true);
		expect(() => registerTools(host.pi)).toThrow("Loadout tool id already registered: read");
	});

	test("activates only the editing tools selected by Edit Mode", (): void => {
		for (const [catalog, expected] of [
			["native", ["edit", "write"]],
			["apply_patch", ["apply_patch"]],
			["none", []],
		] as const) {
			const host = harness();
			registerTools(host.pi);
			activate(host, catalog);
			expect(
				host.activeTools().filter((name) => ["edit", "write", "apply_patch"].includes(name)),
			).toEqual(expected);
		}
	});

	test("can switch the editing catalog after the session has started", (): void => {
		const host = harness();
		registerTools(host.pi);
		activate(host, "native");
		activate(host, "apply_patch");
		expect(
			host.activeTools().filter((name) => ["edit", "write", "apply_patch"].includes(name)),
		).toEqual(["apply_patch"]);
		activate(host, "native");
		expect(
			host.activeTools().filter((name) => ["edit", "write", "apply_patch"].includes(name)),
		).toEqual(["edit", "write"]);
	});

	test("re-registers eval guidelines when the edit catalog changes", (): void => {
		const host = harness();
		const evalTool = registerTools(host.pi);
		activateEditCatalog(
			{
				pi: host.pi,
				resources: { add: (): void => undefined },
			} as unknown as ExtensionLifecycleContext,
			"apply_patch",
			evalTool,
		);
		const registered = [...host.tools].reverse().find((tool) => tool.name === "eval");
		expect(registered?.promptGuidelines?.some((line) => line.includes("and apply_patch"))).toBe(
			true,
		);
	});

	test("activates eval only through its explicit static setting", (): void => {
		const host = harness();
		registerTools(host.pi);
		activateEvalCatalog(
			{
				pi: host.pi,
				resources: { add: (): void => undefined },
			} as unknown as ExtensionLifecycleContext,
			true,
		);
		expect(host.activeTools()).toContain("eval");
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
			...Array.from({ length: 10 }, (_, index) => `H${index + 1}`),
			...Array.from({ length: 29 }, () => "hidden"),
			...Array.from({ length: 9 }, (_, index) => `T${index + 1}`),
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
		expect(call?.render(200).map((line) => line.trimEnd())).toEqual([
			"<success>✓</success> <toolTitle><b>read</b></toolTitle> sample.ts<warning>:9-56</warning>",
		]);
		const preview = read
			.renderResult?.(result, { isPartial: false, expanded: false }, theme, {
				...(renderContext as object),
				args: { path: "sample.ts", offset: 9, limit: 48 },
			} as never)
			?.render(80)
			.join("\n");
		const plainPreview = stripTerminalSequences(preview ?? "");
		expect(plainPreview).toContain(" 9 │ H1");
		expect(plainPreview).toContain("18 │ H10");
		expect(plainPreview).toContain("…");
		expect(plainPreview).toContain("┊");
		const numbered = plainPreview.split("\n").find((line) => line.includes("18 │ H10"));
		const omission = plainPreview.split("\n").find((line) => line.includes("┊"));
		expect(numbered?.indexOf("│")).toBe(omission?.indexOf("┊"));
		expect(plainPreview).toContain("(29 hidden lines, ctrl+o to expand)");
		expect(plainPreview).toContain("48 │ T1");
		expect(plainPreview).toContain("56 │ T9");
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
		expect(lines).toEqual(["<dim>1 char · 2 lines · 0ms</dim>"]);
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
			.render(10);
		if (lines === undefined) throw new Error("read renderer is missing");
		const body = lines.filter((line) => !line.includes("─") && !line.includes("completed"));
		const plainBody = body.map(stripTerminalSequences);
		expect(plainBody).toEqual([" 100 │ ab…"]);
		expect(plainBody.every((line) => visibleWidth(line) <= 10 && !line.includes("\n"))).toBe(true);
	});

	test("keeps narrow grep rows to one cell-width-safe line", (): void => {
		const host = harness();
		registerTools(host.pi);
		const grep = host.tools.find((tool) => tool.name === "grep");
		if (grep === undefined) throw new Error("grep renderer is missing");
		const plainTheme = {
			bg: (_role: string, text: string): string => text,
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		} as Theme;
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
						durationMs: 0,
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

		const grepPlaceholder = grep
			.renderResult?.(
				{
					content: [{ type: "text", text: "No matches found" }],
					details: {
						format: "canonical-grep",
						engine: "rg",
						totalMatched: 0,
						totalFiles: 0,
						totalLines: 0,
						durationMs: 5,
						display: [{ type: "text", text: "No matches found" }],
					},
				},
				{ isPartial: false, expanded: false },
				theme,
				renderContext,
			)
			.render(80);
		expect(grepPlaceholder).toEqual(["<dim>0 matches · 0 files · 0 lines · 5ms</dim>"]);

		const findPlaceholder = find
			.renderResult?.(
				{
					content: [{ type: "text", text: "No files found matching pattern" }],
					details: undefined,
				},
				{ isPartial: false, expanded: false },
				theme,
				renderContext,
			)
			.render(80);
		expect(findPlaceholder).toEqual([]);
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
			"target",
		]);
		const schema = grep.parameters as {
			readonly properties?: { readonly pattern?: { readonly description?: string } };
		};
		expect(schema.properties?.pattern?.description).toContain("after JSON decoding");
		expect(properties(find)).toEqual(["pattern", "path", "exclude", "limit", "cursor", "target"]);
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
		activate(host, "apply_patch");
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

		registerTools(host.pi);
		activate(host, "native");
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

	test("renders native write inside the shared frame without a duplicate built-in header", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const host = harness();
		registerTools(host.pi);
		const write = host.tools.find((tool) => tool.name === "write");
		if (write === undefined) throw new Error("write was not registered");
		const theme = {
			bg: (_role: string, text: string): string => text,
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		} as Theme;
		const args = { path: "value.ts", content: "alpha\nbeta\n" };
		const state = {};
		write.renderCall?.(args, theme, {
			args,
			toolCallId: "write-preview",
			invalidate: (): void => undefined,
			state,
			cwd,
			executionStarted: false,
			argsComplete: true,
			showImages: false,
			expanded: false,
			lastComponent: undefined,
			isPartial: false,
			isError: false,
		} as never);
		const result = await write.execute("write-preview", args, undefined, undefined, {
			cwd,
		} as ExtensionContext);
		const rendered = write
			.renderResult?.(result, { isPartial: false, expanded: false }, theme, {
				args,
				toolCallId: "write-preview",
				invalidate: (): void => undefined,
				state,
				cwd,
				executionStarted: true,
				argsComplete: true,
				showImages: false,
				expanded: false,
				lastComponent: undefined,
				isPartial: false,
				isError: false,
			} as never)
			.render(100)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n");
		expect(rendered).toContain("alpha");
		expect(rendered).toContain("beta");
		expect(rendered).toContain("11 bytes · 2 lines");
		expect(rendered).not.toContain("write value.ts");
	});

	test("renders native edit diff inside the shared frame without a duplicate built-in header", async (): Promise<void> => {
		initTheme("dark");
		const cwd = await temporaryDirectory();
		await writeFile(
			join(cwd, "value.txt"),
			"first\r\nbefore\r\nmiddle\r\nsecond\r\nlast\r\n",
			"utf8",
		);
		const host = harness();
		registerTools(host.pi);
		const edit = host.tools.find((tool) => tool.name === "edit");
		if (edit === undefined) throw new Error("edit was not registered");
		const theme = {
			bg: (_role: string, text: string): string => text,
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const args = {
			path: "value.txt",
			edits: [
				{ oldText: "before", newText: "after" },
				{ oldText: "second", newText: "third" },
			],
		};
		const result = await edit.execute("edit-preview", args, undefined, undefined, {
			cwd,
			sessionManager: {
				getSessionId: (): string => "ext-tools-render-test",
				getSessionFile: (): undefined => undefined,
			},
		} as unknown as ExtensionContext);
		const header = edit
			.renderCall?.(args, theme, {
				...renderCallContextValues,
				args,
				toolCallId: "edit-preview",
				invalidate: (): void => undefined,
				state: {},
				cwd,
				executionStarted: true,
				argsComplete: true,
				showImages: false,
				expanded: false,
			} as never)
			.render(100)
			.map((line) => line.trimEnd())
			.join("\n");
		expect(header).toContain("edit");
		expect(header).toContain("value.txt");
		expect(header).not.toContain("·");
		expect(header).not.toContain("+2 -2");
		expect(header).not.toContain("1 files");
		const rendered = edit
			.renderResult?.(result, { isPartial: false, expanded: false }, theme, {
				args,
				toolCallId: "edit-preview",
				invalidate: (): void => undefined,
				state: {},
				cwd,
				executionStarted: true,
				argsComplete: true,
				showImages: false,
				expanded: false,
				lastComponent: undefined,
				isPartial: false,
				isError: false,
			} as never)
			.render(100)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n");
		if (rendered === undefined) throw new Error("edit renderer is missing");
		expect(rendered).toContain("first");
		expect(rendered).toContain("before");
		expect(rendered).toContain("after");
		expect(rendered).toContain("second");
		expect(rendered).toContain("third");
		expect(rendered).toContain("last");
		expect(rendered).toContain("…");
		expect(rendered).toContain("┊");
		const editNumbered = rendered.split("\n").find((line) => line.includes("2- │"));
		const editOmission = rendered.split("\n").find((line) => line.includes("┊"));
		expect(editNumbered?.indexOf("│")).toBe(editOmission?.indexOf("┊"));
		expect(rendered).toContain("2- │");
		expect(rendered).toContain("4- │");
		expect(rendered).not.toContain("at line");
		expect(rendered).not.toContain("unmodified");
		expect(rendered).not.toContain("<muted>2 edits</muted>");
		expect(rendered).toMatch(/2 edits · \+2 -2 lines · \d+ms/);
		expect(rendered).not.toContain("edit value.txt");
	});

	test("keeps the edit metrics footer after a later Trace collapses the body", async (): Promise<void> => {
		initTheme("dark");
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "value.txt"), "before\n", "utf8");
		const host = harness();
		const tui = createToolTui();
		registerTools(host.pi, undefined, tui);
		const edit = host.tools.find((tool) => tool.name === "edit");
		if (edit === undefined) throw new Error("edit was not registered");
		const args = { path: "value.txt", edits: [{ oldText: "before", newText: "after" }] };
		const ui = { requestRender: (): void => undefined } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"edit",
			"edit-collapsed",
			args,
			undefined,
			edit,
			ui,
			cwd,
		);
		tui.beginTrace();
		component.markExecutionStarted();
		const result = await edit.execute("edit-collapsed", args, undefined, undefined, {
			cwd,
			sessionManager: {
				getSessionId: (): string => "ext-tools-render-test",
				getSessionFile: (): undefined => undefined,
			},
		} as unknown as ExtensionContext);
		component.updateResult({ ...result, isError: false });
		const live = stripTerminalSequences(component.render(100).join("\n"));
		expect(live).toContain("before");
		expect(live).toMatch(/1 edit · \+1 -1 lines · \d+ms/);
		tui.beginTrace();
		const collapsed = stripTerminalSequences(component.render(100).join("\n"));
		expect(collapsed).toContain("edit");
		expect(collapsed).toContain("value.txt");
		expect(collapsed).toMatch(/1 edit · \+1 -1 lines · \d+ms/);
		expect(collapsed).not.toContain("before");

		const resumed = new ToolExecutionComponent(
			"edit",
			"edit-resumed",
			args,
			undefined,
			edit,
			ui,
			cwd,
		);
		resumed.updateResult({
			content: [{ type: "text", text: "Successfully replaced text." }],
			details: {
				patch: ["--- value.txt", "+++ value.txt", "@@ -1,1 +1,1 @@", "-before", "+after"].join(
					"\n",
				),
			},
			isError: false,
		});
		const historical = stripTerminalSequences(resumed.render(100).join("\n"));
		expect(historical).toContain("edit");
		expect(historical).toContain("value.txt");
		expect(historical).toMatch(/1 edit · \+1 -1 lines/);
	});

	test("renders a resumed Pi-native edit from its persisted unified patch", (): void => {
		initTheme("dark");
		const host = harness();
		registerTools(host.pi);
		const edit = host.tools.find((tool) => tool.name === "edit");
		if (edit === undefined) throw new Error("edit was not registered");
		const theme = {
			bg: (_role: string, text: string): string => text,
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		} as Theme;
		const args = {
			path: "value.ts",
			edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }],
		};
		const result = {
			content: [{ type: "text" as const, text: "Successfully replaced text." }],
			details: {
				patch: [
					"--- value.ts",
					"+++ value.ts",
					"@@ -41,3 +41,3 @@",
					" const keep = true;",
					"-const before = 1;",
					"+const after = 2;",
					" export { keep };",
				].join("\n"),
			},
		};
		const rendered = edit
			.renderResult?.(result, { isPartial: false, expanded: true }, theme, {
				args,
				toolCallId: "legacy-edit",
				invalidate: (): void => undefined,
				state: {},
				cwd: "/workspace",
				executionStarted: true,
				argsComplete: true,
				showImages: false,
				expanded: true,
				lastComponent: undefined,
				isPartial: false,
				isError: false,
			} as never)
			.render(100)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n");
		if (rendered === undefined) throw new Error("legacy edit renderer is missing");
		expect(rendered).toContain("42- │ const before = 1;");
		expect(rendered).toContain("42+ │ const after = 2;");
		expect(rendered).not.toContain("Successfully replaced text.");
	});

	test("preserves persisted edit text when no legacy patch can be rendered", (): void => {
		const host = harness();
		registerTools(host.pi);
		const edit = host.tools.find((tool) => tool.name === "edit");
		if (edit === undefined) throw new Error("edit was not registered");
		const theme = {
			bg: (_role: string, text: string): string => text,
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		} as Theme;
		const rendered = edit
			.renderResult?.(
				{
					content: [{ type: "text", text: "Edit failed: old text was not found" }],
					details: { patch: "not a unified patch" },
				},
				{ isPartial: false, expanded: true },
				theme,
				{
					args: { path: "value.ts", edits: [] },
					isError: false,
				} as never,
			)
			.render(100)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n");
		if (rendered === undefined) throw new Error("edit renderer is missing");
		expect(rendered).toContain("Edit failed: old text was not found");
		expect(rendered.split("Edit failed: old text was not found")).toHaveLength(2);
	});

	test("clips edit context rows to the live TUI width", async (): Promise<void> => {
		initTheme("dark");
		const cwd = await temporaryDirectory();
		const contextLine = `keep ${"x".repeat(120)}`;
		await writeFile(join(cwd, "value.txt"), `${contextLine}\nbefore\n`, "utf8");
		const host = harness();
		registerTools(host.pi);
		const edit = host.tools.find((tool) => tool.name === "edit");
		if (edit === undefined) throw new Error("edit was not registered");
		const theme = {
			bg: (_role: string, text: string): string => text,
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const args = { path: "value.txt", edits: [{ oldText: "before", newText: "after" }] };
		const result = await edit.execute("edit-clip", args, undefined, undefined, {
			cwd,
			sessionManager: {
				getSessionId: (): string => "ext-tools-render-test",
				getSessionFile: (): undefined => undefined,
			},
		} as unknown as ExtensionContext);
		const rows = edit
			.renderResult?.(result, { isPartial: false, expanded: false }, theme, {
				args,
				toolCallId: "edit-clip",
				invalidate: (): void => undefined,
				state: {},
				cwd,
				executionStarted: true,
				argsComplete: true,
				showImages: false,
				expanded: false,
				lastComponent: undefined,
				isPartial: false,
				isError: false,
			} as never)
			.render(40);
		if (rows === undefined) throw new Error("edit renderer is missing");
		const contextRows = rows.filter((line) => stripTerminalSequences(line).includes("keep "));
		expect(contextRows).toHaveLength(1);
		expect(visibleWidth(contextRows[0] ?? "")).toBeLessThanOrEqual(40);
		expect(stripTerminalSequences(contextRows[0] ?? "")).toContain("…");
		expect(stripTerminalSequences(contextRows[0] ?? "")).not.toContain("x".repeat(80));
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
			"<warning>◐</warning> <toolTitle>grep</toolTitle> <mdCode>/needle/</mdCode> in src",
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
		if (grepResult === undefined) throw new Error("grep renderer is missing");
		expect(grepResult).toContain("src/a.ts");
		expect(grepResult).not.toContain("<text>src/a.ts</text>");
		expect(stripTerminalSequences(grepResult ?? "")).toContain("  1 │ before");
		expect(stripTerminalSequences(grepResult ?? "")).toContain(" 12 │ needle");
		expect(stripTerminalSequences(grepResult ?? "")).toContain(" 13 │   needle trailing");
		expect(grepResult).toContain("\x1b[2m");
		expect(grepResult).toContain("\x1b[48;2;18;42;28m");
		expect(grepResult).not.toContain("1 matches in 1 files");
		expect(grepResult).toContain("<dim>1 match · 1 file · 3 lines · 3.7s</dim>");
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
					display: Array.from({ length: 30 }, (_, index) => ({
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
		expect(collapsed).toHaveLength(23);
		expect(collapsed.at(-3)).toContain("… (11 more lines, expand to show)");
		expect(collapsed.at(-1)).toContain("20 matches · 1 file · 20 lines · 0ms");
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

	test("wraps the current grep header instead of truncating it", (): void => {
		const host = harness();
		registerTools(host.pi);
		const grep = host.tools.find((tool) => tool.name === "grep");
		if (grep === undefined) throw new Error("grep was not registered");
		const plainTheme = {
			bg: (_role: string, text: string): string => text,
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		} as Theme;
		const header = grep
			.renderCall?.(
				{ pattern: "very-long-needle", path: "a/very/long/search/path" },
				plainTheme,
				renderCallContext,
			)
			.render(16);
		if (header === undefined) throw new Error("grep call renderer is missing");
		expect(header.join("")).toContain("very-long-needle");
		expect(header.join("")).toContain("a/very/long/search/path");
		expect(header.join("\n")).not.toContain("…");
		expect(header.length).toBeGreaterThan(1);
	});

	test("keeps grep match syntax bright and dims the rest of the line", (): void => {
		const host = harness();
		registerTools(host.pi);
		const theme = {
			bg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const grep = host.tools.find((candidate) => candidate.name === "grep");
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
						durationMs: 1,
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
		expect(result).not.toContain("<text>");
		expect(result.indexOf(`${dim}hello `)).toBeLessThan(result.indexOf(`${addBg}needle`));
		expect(result.indexOf(`${addBg}needle`)).toBeLessThan(result.indexOf(`${dim} world`));
		expect(result).toContain(reset);
	});

	test("keeps dim syntax after a highlighted grep match", (): void => {
		const host = harness();
		registerTools(host.pi);
		const theme = {
			bg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
			bold: (text: string): string => text,
		} as Theme;
		const grep = host.tools.find((candidate) => candidate.name === "grep");
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
						durationMs: 1,
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
			"<warning>◐</warning> <toolTitle><b>find</b></toolTitle> <mdCode>/needle/</mdCode> in src",
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
		if (result === undefined) throw new Error("Expected find result renderer");
		expect(result.filter((line) => line.includes("─"))).toHaveLength(2);
		expect(result).toContain("fuzzy files:");
		expect(result).toContain("src/");
		expect(result).toContain("a.ts");
		expect(result).toContain("fuzzy paths:");
		expect(result).toContain("docs/readme.md");
		expect(result.join("\n")).not.toContain("<text>");
		expect(result).toContain("<dim>2 fuzzy files · 1 fuzzy path · 7 lines · 20ms</dim>");
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

	test("publishes successful hunks when another hunk fails", async (): Promise<void> => {
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
				"- operation 1, value.txt, hunk 2: best fuzzy score 0.00 < required 0.70\n" +
				"Recovery: read value.txt, then retry only rejected hunks from operation 1.\n" +
				"Do not retry applied hunks.",
		});
		expect(await readFile(join(cwd, "value.txt"), "utf8")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
	});

	test("persists only the visible write diff instead of the unchanged file body", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const head = Array.from({ length: 40 }, (_value, index) => `head-${index}`).join("\n");
		const tail = Array.from({ length: 40 }, (_value, index) => `tail-${index}`).join("\n");
		await writeFile(join(cwd, "value.txt"), `${head}\nOLD\n${tail}\n`, "utf8");
		const host = harness();
		registerTools(host.pi);
		const write = host.tools.find((tool) => tool.name === "write");
		if (write === undefined) throw new Error("write was not registered");
		const args = { path: "value.txt", content: `${head}\nNEW\n${tail}\n` };
		const written = await write.execute("write-snippet", args, undefined, undefined, {
			cwd,
		} as ExtensionContext);
		const serialized = JSON.stringify(
			(written.details as Record<string, unknown>).__piExtToolsWriteView ?? {},
		);
		expect(serialized).not.toContain("head-0");
		expect(serialized).not.toContain("tail-39");
		const rendered = write
			.renderResult?.(
				written,
				{ isPartial: false, expanded: false },
				{
					bg: (_role: string, text: string): string => text,
					fg: (_role: string, text: string): string => text,
					bold: (text: string): string => text,
				} as Theme,
				{
					args,
					toolCallId: "write-snippet",
					invalidate: (): void => undefined,
					state: {},
					cwd,
					executionStarted: true,
					argsComplete: true,
					showImages: false,
					expanded: false,
					lastComponent: undefined,
					isPartial: false,
					isError: false,
				} as never,
			)
			?.render(100)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n");
		expect(rendered).toContain("OLD");
		expect(rendered).toContain("NEW");
	});

	test("renders a legacy persisted write diff without full file bodies", (): void => {
		const host = harness();
		registerTools(host.pi);
		const write = host.tools.find((tool) => tool.name === "write");
		if (write === undefined) throw new Error("write was not registered");
		const rendered = write
			.renderResult?.(
				{
					content: [{ type: "text", text: "Wrote 1 file" }],
					details: {
						__piExtToolsWriteView: {
							kind: "diff",
							summary: "+1 -1",
							oldContent: "OLD\n",
							newContent: "NEW\n",
						},
					},
				},
				{ isPartial: false, expanded: false },
				{
					bg: (_role: string, text: string): string => text,
					fg: (_role: string, text: string): string => text,
					bold: (text: string): string => text,
				} as Theme,
				{
					args: { path: "value.txt", content: "NEW\n" },
					toolCallId: "write-legacy",
					invalidate: (): void => undefined,
					state: {},
					cwd: ".",
					executionStarted: true,
					argsComplete: true,
					showImages: false,
					expanded: false,
					lastComponent: undefined,
					isPartial: false,
					isError: false,
				} as never,
			)
			?.render(100)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n");
		if (rendered === undefined) throw new Error("write renderer is missing");
		expect(rendered).toContain("OLD");
		expect(rendered).toContain("NEW");
		expect(rendered.split("\n").at(-1)).toContain("+1 -1");
		expect(rendered.split("\n").some((line) => line.includes("│") && line.includes("+1 -1"))).toBe(
			false,
		);
	});

	test("keeps custom write/edit views when the existing file exceeds the highlight budget", async (): Promise<void> => {
		const cwd = await temporaryDirectory();
		const huge = `HEAD\n${"x".repeat(MAX_HL_CHARS)}\n`;
		await writeFile(join(cwd, "huge.txt"), huge, "utf8");
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
		const writeRendered = write
			.renderResult?.(
				written,
				{ isPartial: false, expanded: false },
				{
					bg: (_role: string, text: string): string => text,
					fg: (_role: string, text: string): string => text,
					bold: (text: string): string => text,
				} as Theme,
				{
					args: { path: "huge.txt", content: "small\n" },
					toolCallId: "write-huge",
					invalidate: (): void => undefined,
					state: {},
					cwd,
					executionStarted: true,
					argsComplete: true,
					showImages: false,
					expanded: false,
					lastComponent: undefined,
					isPartial: false,
					isError: false,
				} as never,
			)
			?.render(100)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n");
		if (writeRendered === undefined) throw new Error("write renderer is missing");
		expect(writeRendered).toContain("wrote (1 lines)");
		expect(writeRendered).toContain("small");
		expect(writeRendered).not.toContain("Wrote");
		expect(writeRendered).not.toContain("at line");

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
