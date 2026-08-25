import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createOutputRegistry, createToolTui } from "@hheei/pi-ext-core";
import { expect, test } from "vitest";
import { registerBashTool } from "../src/bash.js";
import type { FffRuntimeState } from "../src/fff/lifecycle.js";
import { DEFAULT_FFF_SETTINGS, DEFAULT_RTK_SETTINGS } from "../src/fff/settings.js";
import { TargetRuntime } from "../src/targets.js";

initTheme(undefined, false);

test("bash executes through Pi host original backend", async (): Promise<void> => {
	const tools: ToolDefinition[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition): void => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	registerBashTool(pi);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");

	const result = await bash.execute(
		"bash-original-backend",
		{ command: "printf restored-backend" },
		new AbortController().signal,
		() => undefined,
		{
			cwd: process.cwd(),
			sessionManager: {
				getSessionId: () => "bash-backend-test",
				getSessionFile: () => undefined,
			},
		} as ExtensionContext,
	);

	expect(result.content).toEqual([{ type: "text", text: "restored-backend" }]);
});

test("bash never streams Pi host temporary output paths", async (): Promise<void> => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	const updates: unknown[] = [];
	await bash.execute(
		"bash-streamed-path-redaction",
		{ command: "yes x | head -c 1100000" },
		undefined,
		(update): void => {
			updates.push(update);
		},
		{
			cwd: process.cwd(),
			sessionManager: {
				getSessionId: () => "bash-streamed-path-redaction",
				getSessionFile: () => undefined,
			},
		} as ExtensionContext,
	);
	expect(updates.length).toBeGreaterThan(0);
	expect(updates.map((update) => JSON.stringify(update)).join("\n")).not.toContain(
		"fullOutputPath",
	);
});

test("bash exposes PTY only in interactive TUI mode", async (): Promise<void> => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	expect(bash.parameters).toMatchObject({
		anyOf: [
			expect.anything(),
			expect.anything(),
			{ properties: { pty: { const: true } }, additionalProperties: false },
		],
	});
	const result = await bash.execute(
		"bash-pty-unavailable",
		{ command: "printf unavailable", pty: true },
		undefined,
		undefined,
		{ cwd: process.cwd(), mode: "print" } as ExtensionContext,
	);
	expect(result).toMatchObject({
		content: [{ type: "text", text: "PTY Bash requires an interactive TUI with PTY enabled" }],
		details: { error: "pty_unavailable" },
	});
});

test("bash exposes only async and PTY use guidance", (): void => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	expect(bash.description).toBe("Run one shell command or short pipeline.");
	expect(bash.promptSnippet).toBe("Run one shell command or short pipeline.");
	expect(bash.promptGuidelines).toEqual([
		"Use `async` only for finite commands that may outlive this tool call.",
		"Use `pty` only for interactive terminal programs such as `sudo` or `ssh`.",
		"NEVER combine `pty` with `async`.",
		"Remote `target` is an authorized SSH host; omit pty and async. Working directory is the remote home.",
	]);
});

test("bash displays its active command in the base theme and timeout dim", (): void => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	const theme = {
		bg: (_role: string, text: string): string => text,
		fg: (role: string, text: string): string => (role === "dim" ? `<dim>${text}</dim>` : text),
		bold: (text: string): string => text,
	} as Theme;
	const text = bash
		.renderCall?.({ command: "printf one", timeout: 120 }, theme, {
			isError: false,
			isPartial: true,
			lastComponent: undefined,
			state: {},
		} as never)
		.render(120)
		.join("\n");
	if (text === undefined) throw new Error("Expected bash call renderer");
	expect(text.match(/printf one/g)).toHaveLength(1);
	expect(text).not.toContain("<dim>printf one</dim>");
	expect(text).toContain("<dim> (timeout 120s)</dim>");
});

test("bash wraps the active command and retains its timeout suffix", (): void => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	const theme = {
		bg: (_role: string, text: string): string => text,
		fg: (_role: string, text: string): string => text,
		bold: (text: string): string => text,
	} as Theme;
	const text = bash
		.renderCall?.({ command: "printf first\nprintf second", timeout: 20 }, theme, {
			isError: false,
			isPartial: true,
			lastComponent: undefined,
			state: {},
		} as never)
		.render(80)
		.join("\n");
	expect(text).toContain("printf second");
	expect(text).toContain("(timeout 20s)");
});

test("bash collapses only the previous command before its timeout suffix", async (): Promise<void> => {
	const tools: ToolDefinition[] = [];
	const tui = createToolTui();
	registerBashTool(
		{
			registerTool(tool: ToolDefinition): void {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI,
		undefined,
		tui,
	);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	tui.beginTrace();
	await bash.execute("previous-bash", { command: "true" }, undefined, undefined, {
		cwd: process.cwd(),
	} as ExtensionContext);
	tui.beginTrace();
	const theme = {
		bg: (_role: string, text: string): string => text,
		fg: (_role: string, text: string): string => text,
		bold: (text: string): string => text,
	} as Theme;
	const line = bash
		.renderCall?.({ command: `printf ${"x".repeat(80)}`, timeout: 20 }, theme, {
			isError: false,
			isPartial: false,
			lastComponent: undefined,
			state: {},
			toolCallId: "previous-bash",
			executionStarted: false,
			expanded: false,
			invalidate: (): void => undefined,
		} as never)
		.render(40)[0];
	expect(line).toContain("✓ bash");
	const plainLine = stripTerminalSequences(line ?? "");
	expect(plainLine).toContain("…");
	expect(plainLine.trimEnd().endsWith("(timeout 20s)")).toBe(true);
});

test("bash encloses its output between full-width dividers", (): void => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	const theme = {
		bg: (_role: string, text: string): string => text,
		fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
		bold: (text: string): string => text,
	} as Theme;
	const lines = bash
		.renderResult?.(
			{ content: [{ type: "text", text: "stdout" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			{
				args: { command: "printf stdout" },
				isError: false,
				isPartial: false,
				lastComponent: undefined,
				state: {},
			} as never,
		)
		.render(40);
	expect(lines?.[0]).toBe(`<muted>${"─".repeat(40)}</muted>`);
	expect(lines?.at(-2)).toBe(`<muted>${"─".repeat(40)}</muted>`);
	expect(lines?.at(-1)).toBe("<dim>exit ? · 1 line · completed</dim>");
	expect(lines?.join("\n")).toContain("stdout");
	expect(lines?.join("\n")).not.toContain("<text>stdout");
	expect(lines?.join("\n")).not.toContain("<toolOutput>stdout</toolOutput>");
});

test("bash omits body rails when output has zero lines", (): void => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	const theme = {
		bg: (_role: string, text: string): string => text,
		fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
		bold: (text: string): string => text,
	} as Theme;
	const lines = bash
		.renderResult?.(
			{ content: [{ type: "text", text: "" }], details: { output: "", exitCode: 0 } },
			{ expanded: false, isPartial: false },
			theme,
			{
				args: { command: "true" },
				isError: false,
				isPartial: false,
				lastComponent: undefined,
				state: {},
			} as never,
		)
		.render(40);
	expect(lines).toEqual(["<dim>exit 0 · 0 lines · completed</dim>"]);
});

test("bash removes renderer padding around short newline-terminated output", (): void => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	const theme = {
		bg: (_role: string, text: string): string => text,
		fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
		bold: (text: string): string => text,
	} as Theme;
	for (const isPartial of [true, false]) {
		const lines = bash
			.renderResult?.(
				{ content: [{ type: "text", text: "one\ntwo\n" }], details: {} },
				{ expanded: false, isPartial },
				theme,
				{
					args: { command: "printf 'one\\ntwo\\n'" },
					isError: false,
					isPartial,
					lastComponent: undefined,
					state: {},
				} as never,
			)
			.render(40);
		const body = lines?.filter((line) => !line.includes("─") && !line.includes("exit "));
		expect(body).toHaveLength(2);
		expect(body?.[0]).toContain("one");
		expect(body?.[1]).toContain("two");
	}
});

test("bash compacts and dims its collapsed earlier-lines hint", (): void => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	const theme = {
		bg: (_role: string, text: string): string => text,
		fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
		bold: (text: string): string => text,
	} as Theme;
	const text = bash
		.renderResult?.(
			{
				content: [
					{
						type: "text",
						text: Array.from({ length: 90 }, (_, index) => `line ${index}`).join("\n"),
					},
				],
				details: {},
			},
			{ expanded: false, isPartial: false },
			theme,
			{
				args: { command: "printf many" },
				isError: false,
				isPartial: false,
				lastComponent: undefined,
				state: {},
			} as never,
		)
		.render(120)
		.join("\n");
	expect(text).toMatch(/<dim>… \(\d+ earlier lines,/);
	expect(text).not.toMatch(/\n<text><\/text>\n<text><dim>\.\.\./);
	expect(text).not.toMatch(/<\/dim><\/text>\n<text><\/text>\n<text>line/);
});

test("bash keeps its unexpanded body to the shared ToolTui height cap", (): void => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	const theme = {
		bg: (_role: string, text: string): string => text,
		fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
		bold: (text: string): string => text,
	} as Theme;
	const component = bash.renderResult?.(
		{
			content: [
				{
					type: "text",
					text: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"),
				},
			],
			details: {},
		},
		{ expanded: false, isPartial: true },
		theme,
		{
			args: { command: "printf many" },
			isError: false,
			isPartial: true,
			lastComponent: undefined,
			state: {},
		} as never,
	);
	if (component === undefined) throw new Error("Expected bash result renderer");
	const rendered = component.render(120).filter((line) => !line.includes("─"));
	expect(rendered).toHaveLength(20);
	expect(rendered[0]).toContain("… (11 earlier lines, ctrl+o to expand)");
	expect(rendered[0]).toContain("<dim>");
	expect(rendered.at(-1)).toContain("line 30");
	expect(rendered.join("\n")).not.toContain("exit ?");
	const completed = bash.renderResult?.(
		{
			content: [
				{
					type: "text",
					text: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"),
				},
			],
			details: {},
		},
		{ expanded: true, isPartial: false },
		theme,
		{
			args: { command: "printf many" },
			isError: false,
			isPartial: false,
			lastComponent: undefined,
			state: {},
		} as never,
	);
	if (completed === undefined) throw new Error("Expected completed bash result renderer");
	const completedLines = completed
		.render(120)
		.filter((line) => !line.includes("─") && !line.includes("exit ?"));
	expect(completedLines).toHaveLength(30);
	expect(completedLines.at(-1)).toContain("line 30");
});

test("bash omitted-line count uses logical lines, not wraps or the tail window", (): void => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	const theme = {
		bg: (_role: string, text: string): string => text,
		fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
		bold: (text: string): string => text,
	} as Theme;
	const long = Array.from({ length: 30 }, (_, index) => `line ${index + 1} ${"x".repeat(80)}`).join(
		"\n",
	);
	const body = bash.renderResult?.(
		{ content: [{ type: "text", text: long }], details: {} },
		{ expanded: false, isPartial: true },
		theme,
		{
			args: { command: "printf long" },
			isError: false,
			isPartial: true,
			lastComponent: undefined,
			state: {},
		} as never,
	);
	if (body === undefined) throw new Error("Expected wrapped bash body");
	const narrow = body.render(20).filter((line) => !line.includes("─"));
	const wide = body.render(120).filter((line) => !line.includes("─"));
	expect(narrow).toHaveLength(20);
	expect(wide).toHaveLength(20);
	expect(wide[0]).toContain("… (11 earlier lines, ctrl+o to expand)");
	const tail = bash
		.renderResult?.(
			{
				content: [{ type: "text", text: "tail-a\ntail-b\ntail-c" }],
				details: { totalLines: 80 },
			},
			{ expanded: false, isPartial: true },
			theme,
			{
				args: { command: "printf tail" },
				isError: false,
				isPartial: true,
				lastComponent: undefined,
				state: {},
			} as never,
		)
		?.render(120)
		.filter((line) => !line.includes("─"));
	if (tail === undefined) throw new Error("Expected tailed bash body");
	expect(tail[0]).toContain("… (77 earlier lines, ctrl+o to expand)");
});

test("bash summarizes exit code, output lines, and duration in collapsed traces", async (): Promise<void> => {
	const tools: ToolDefinition[] = [];
	const tui = createToolTui();
	registerBashTool(
		{
			registerTool(tool: ToolDefinition): void {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI,
		undefined,
		tui,
	);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	tui.beginTrace();
	const result = await bash.execute(
		"completed-bash",
		{ command: "printf 'one\\ntwo\\n'" },
		undefined,
		undefined,
		{ cwd: process.cwd() } as ExtensionContext,
	);
	tui.beginTrace();
	const theme = {
		bg: (_role: string, text: string): string => text,
		fg: (_role: string, text: string): string => text,
		bold: (text: string): string => text,
	} as Theme;
	const footer = bash
		.renderResult?.(result, { expanded: false, isPartial: false }, theme, {
			args: { command: "printf 'one\\ntwo\\n'" },
			isError: false,
			isPartial: false,
			lastComponent: undefined,
			state: {},
			toolCallId: "completed-bash",
			executionStarted: false,
			expanded: false,
			invalidate: (): void => undefined,
		} as never)
		.render(120)
		.join("\n");
	expect(footer).toMatch(/exit 0 · 2 lines · \d+ms/);
});

test("bash rejects output, pty, and async on SSH targets", async (): Promise<void> => {
	const tools: ToolDefinition[] = [];
	registerBashTool({
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash === undefined) throw new Error("Expected bash tool");
	const context = { cwd: process.cwd() } as ExtensionContext;
	expect(
		await bash.execute(
			"bash-output",
			{ command: "true", target: "output" },
			undefined,
			undefined,
			context,
		),
	).toMatchObject({
		content: [{ type: "text", text: "bash does not support output targets." }],
		details: { error: "unauthorized", target: "output" },
	});
	expect(
		await bash.execute(
			"bash-remote-pty",
			{ command: "true", target: "ileqm", pty: true },
			undefined,
			undefined,
			context,
		),
	).toMatchObject({
		content: [{ type: "text", text: "PTY Bash is local-only; omit pty for SSH targets." }],
		details: { error: "pty_unsupported", target: "ileqm" },
	});
	expect(
		await bash.execute(
			"bash-remote-async",
			{ command: "true", target: "ileqm", async: true },
			undefined,
			undefined,
			context,
		),
	).toMatchObject({
		content: [{ type: "text", text: "Async Bash is local-only; omit async for SSH targets." }],
		details: { error: "async_unsupported", target: "ileqm" },
	});
	await expect(
		bash.execute(
			"bash-remote-missing-runtime",
			{ command: "true", target: "ileqm" },
			undefined,
			undefined,
			context,
		),
	).rejects.toThrow("Target runtime is unavailable.");
});

test("bash executes authorized SSH targets from remote home", async (): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "hepi-bash-remote-"));
	const bin = join(directory, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "ssh"),
		[
			"#!/bin/sh",
			'last=""',
			'for arg in "$@"; do last=$arg; done',
			'if [ "$last" = "uname -s" ]; then echo Linux; exit 0; fi',
			'eval "$last"',
			"",
		].join("\n"),
		"utf8",
	);
	await chmod(join(bin, "ssh"), 0o755);
	await writeFile(join(directory, "ssh-config"), "Host ileqm\n  HostName example.test\n", "utf8");
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	try {
		const runtime = await TargetRuntime.create(
			{
				outputs: createOutputRegistry(),
				home: directory,
				sshConfigPath: join(directory, "ssh-config"),
			},
			["ileqm"],
		);
		try {
			const tools: ToolDefinition[] = [];
			const state: FffRuntimeState = {
				getRuntime: () => undefined,
				getSettings: () => DEFAULT_FFF_SETTINGS,
				getRtkSettings: () => DEFAULT_RTK_SETTINGS,
				getBashJobs: () => undefined,
				getOutputs: () => createOutputRegistry(),
				getTargetRuntime: () => runtime,
				consumeRtkRewriteWarning: () => false,
			};
			registerBashTool(
				{
					registerTool(tool: ToolDefinition): void {
						tools.push(tool);
					},
					on(): void {},
				} as unknown as ExtensionAPI,
				state,
			);
			const bash = tools.find((tool) => tool.name === "bash");
			if (bash === undefined) throw new Error("Expected bash tool");
			const result = await bash.execute(
				"bash-remote-ok",
				{ command: "printf remote-ok", target: "ileqm" },
				undefined,
				undefined,
				{ cwd: process.cwd() } as ExtensionContext,
			);
			expect(result.content).toEqual([{ type: "text", text: "remote-ok" }]);
			expect(result.details).toMatchObject({
				exitCode: 0,
				target: "ileqm",
				outcome: "ok",
			});
			const denied = await bash.execute(
				"bash-remote-denied",
				{ command: "true", target: "nope" },
				undefined,
				undefined,
				{ cwd: process.cwd() } as ExtensionContext,
			);
			expect(denied.content[0]).toMatchObject({
				type: "text",
				text: "Unknown or unauthorized SSH target: nope",
			});
		} finally {
			await runtime.close();
		}
	} finally {
		process.env.PATH = previousPath;
		await rm(directory, { recursive: true, force: true });
	}
});
