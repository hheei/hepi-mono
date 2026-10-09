import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { expect, test } from "vitest";
import { BashInput, registerBashTool } from "../src/bash.js";
import { createFffRuntimeState, type FffRuntimeState } from "../src/fff/lifecycle.js";
import { DEFAULT_FFF_SETTINGS } from "../src/fff/settings.js";
import { TargetRuntime } from "../src/targets.js";
import { registerTaskTools } from "../src/task-tools.js";
import { toolFor, toolHost } from "./fixtures/harness.js";
import { roleTheme } from "./fixtures/theme.js";

initTheme(undefined, false);

test("bash uses one flat object schema for strict tool providers", (): void => {
	expect(BashInput).toMatchObject({ type: "object", additionalProperties: false });
	expect(BashInput).not.toHaveProperty("anyOf");
	expect(BashInput.properties).toHaveProperty("command");
	expect(BashInput.properties).toHaveProperty("blocking");
	expect(BashInput.properties).not.toHaveProperty("async");
	expect(Value.Check(BashInput, { command: "pwd" })).toBe(true);
	expect(Value.Check(BashInput, { command: "pwd", blocking: false })).toBe(true);
	expect(Value.Check(BashInput, { command: "pwd", blocking: true })).toBe(true);
	// The legacy `async` parameter is rejected instead of being silently reinterpreted.
	expect(Value.Check(BashInput, { command: "pwd", async: true })).toBe(false);
	expect(Value.Check(BashInput, {})).toBe(false);
	expect(Value.Check(BashInput, { command: "" })).toBe(false);
});

/** The render context Pi passes for a bash result, plus whatever a test needs on top. */
function bashContext(
	command: string,
	isPartial = false,
	extra: Record<string, unknown> = {},
): never {
	return {
		args: { command },
		isError: false,
		isPartial,
		lastComponent: undefined,
		state: {},
		...extra,
	} as never;
}

/** Registers bash on a capturing host and returns it, optionally framed by a ToolTui. */
function bashTool(): ToolDefinition {
	const host = toolHost();
	registerBashTool(host.pi, undefined);
	return toolFor(host.tools, "bash");
}

test("bash executes through Pi host original backend", async (): Promise<void> => {
	const bash = bashTool();

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
				getLeafId: () => null,
			},
		} as unknown as ExtensionToolContext,
	);

	expect(result.content).toEqual([{ type: "text", text: "restored-backend" }]);
});

test("bash never streams Pi host temporary output paths", async (): Promise<void> => {
	const bash = bashTool();
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
				getLeafId: () => null,
			},
		} as unknown as ExtensionToolContext,
	);
	expect(updates.length).toBeGreaterThan(0);
	expect(updates.map((update) => JSON.stringify(update)).join("\n")).not.toContain(
		"fullOutputPath",
	);
});

test("bash rejects unknown fields before any command starts", async (): Promise<void> => {
	const bash = bashTool();
	await expect(
		bash.execute(
			"bash-invalid-parameters",
			{ command: "printf unavailable", unsupported: true },
			undefined,
			undefined,
			{
				cwd: process.cwd(),
				mode: "print",
				sessionManager: { getLeafId: () => null },
			} as unknown as ExtensionToolContext,
		),
	).rejects.toThrow("Invalid bash parameters");
});

test("bash accepts null strict optional fields as omitted", async (): Promise<void> => {
	const bash = bashTool();
	const result = await bash.execute(
		"bash-null-optional-fields",
		{ command: "printf normalized", timeout: null, blocking: null, target: null },
		undefined,
		undefined,
		{
			cwd: process.cwd(),
			mode: "print",
			sessionManager: { getLeafId: () => null },
		} as unknown as ExtensionToolContext,
	);
	expect(result.content).toEqual([{ type: "text", text: "normalized" }]);
});

test("aborted signal skips foreground Bash spawn", async (): Promise<void> => {
	const bash = bashTool();
	const controller = new AbortController();
	controller.abort();
	const result = await bash.execute(
		"bash-aborted-prespawn",
		{ command: "printf spawned" },
		controller.signal,
		() => undefined,
		{
			cwd: process.cwd(),
			sessionManager: { getLeafId: () => null },
		} as unknown as ExtensionToolContext,
	);
	expect(result).toMatchObject({
		content: [{ type: "text", text: "Bash aborted" }],
		details: { error: "aborted" },
	});
});

test("bash exposes only background use guidance", (): void => {
	const bash = bashTool();
	expect(bash.description).toBe("Run one shell command or short pipeline.");
	expect(bash.promptSnippet).toBe("Run one shell command or short pipeline.");
	expect(bash.promptGuidelines).toEqual([
		"Use `blocking: false` only for finite commands that may outlive this tool call. Work on other tasks while it runs; once hands-on work is complete, call `wait_jobs` to wait for any unfinished background jobs.",
		"Remote `target` is an authorized SSH host and always runs in the foreground.",
	]);
});

test("task-control tools keep usage guidance in descriptions without changing system rules", (): void => {
	const tools: ToolDefinition[] = [];
	registerTaskTools(
		{
			registerTool(tool: ToolDefinition): void {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI,
		createFffRuntimeState(),
	);
	expect(tools.map((tool) => tool.promptGuidelines)).toEqual([undefined, undefined, undefined]);
	expect(toolFor(tools, "wait_jobs").description).toContain("Do not poll background jobs");
	expect(toolFor(tools, "wait_jobs").parameters).toMatchObject({
		properties: { ids: { description: expect.stringContaining("agent-1") } },
	});
	expect(toolFor(tools, "stop_jobs").description).toContain(
		"when their results are no longer needed",
	);
});

test("bash removes renderer padding around short newline-terminated output", (): void => {
	const bash = bashTool();
	const theme = roleTheme;
	for (const isPartial of [true, false]) {
		const lines = bash
			.renderResult?.(
				{ content: [{ type: "text", text: "one\ntwo\n" }], details: {} },
				{ expanded: false, isPartial },
				theme,
				bashContext("printf 'one\\ntwo\\n'", isPartial),
			)
			.render(40);
		const body = lines?.filter((line) => !line.includes("─") && !line.includes("exit "));
		expect(body).toHaveLength(2);
		expect(body?.[0]).toContain("one");
		expect(body?.[1]).toContain("two");
	}
});

test("bash compacts and dims its collapsed earlier-lines hint", (): void => {
	const bash = bashTool();
	const theme = roleTheme;
	const text = bash
		.renderResult?.(
			{
				content: [
					{
						type: "text",
						text: Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n"),
					},
				],
				details: {},
			},
			{ expanded: false, isPartial: false },
			theme,
			bashContext("printf many"),
		)
		.render(120)
		.join("\n");
	expect(text).toMatch(/<dim>… \(\d+ earlier lines,/);
});

test("bash keeps its unexpanded body to the shared ToolTui height cap", (): void => {
	const bash = bashTool();
	const theme = roleTheme;
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
		bashContext("printf many", true),
	);
	if (component === undefined) throw new Error("Expected bash result renderer");
	const rendered = component.render(120).filter((line) => !line.includes("─"));
	expect(rendered).toHaveLength(10);
	expect(rendered[0]).toContain("… (21 earlier lines, ctrl+o to expand)");
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
		bashContext("printf many"),
	);
	if (completed === undefined) throw new Error("Expected completed bash result renderer");
	const completedLines = completed
		.render(120)
		.filter((line) => !line.includes("─") && !line.includes("exit ?"));
	expect(completedLines).toHaveLength(30);
	expect(completedLines.at(-1)).toContain("line 30");
});

test("bash omitted-line count uses logical lines, not wraps or the tail window", (): void => {
	const bash = bashTool();
	const theme = roleTheme;
	const long = Array.from({ length: 30 }, (_, index) => `line ${index + 1} ${"x".repeat(80)}`).join(
		"\n",
	);
	const body = bash.renderResult?.(
		{ content: [{ type: "text", text: long }], details: {} },
		{ expanded: false, isPartial: true },
		theme,
		bashContext("printf long", true),
	);
	if (body === undefined) throw new Error("Expected wrapped bash body");
	const narrow = body.render(20).filter((line) => !line.includes("─"));
	const wide = body.render(120).filter((line) => !line.includes("─"));
	expect(narrow).toHaveLength(10);
	expect(wide).toHaveLength(10);
	expect(wide[0]).toContain("… (21 earlier lines, ctrl+o to expand)");
	const tail = bash
		.renderResult?.(
			{
				content: [{ type: "text", text: "tail-a\ntail-b\ntail-c" }],
				details: { totalLines: 80 },
			},
			{ expanded: false, isPartial: true },
			theme,
			bashContext("printf tail", true),
		)
		?.render(120)
		.filter((line) => !line.includes("─"));
	if (tail === undefined) throw new Error("Expected tailed bash body");
	expect(tail[0]).toContain("… (77 earlier lines, ctrl+o to expand)");
});

test("bash rejects background execution on SSH targets", async (): Promise<void> => {
	const bash = bashTool();
	const context = { cwd: process.cwd() } as unknown as ExtensionToolContext;
	expect(
		await bash.execute(
			"bash-remote-async",
			{ command: "true", target: "ileqm", blocking: false },
			undefined,
			undefined,
			context,
		),
	).toMatchObject({
		content: [
			{ type: "text", text: "Background Bash is local-only; omit blocking for SSH targets." },
		],
		details: { error: "background_unsupported", target: "ileqm" },
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
				getTasks: () => undefined,
				getBashJobs: () => undefined,
				getTargetRuntime: () => runtime,
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
			const bash = toolFor(tools, "bash");
			const result = await bash.execute(
				"bash-remote-ok",
				{ command: "printf remote-ok", target: "ileqm" },
				undefined,
				undefined,
				{
					cwd: process.cwd(),
					sessionManager: { getLeafId: () => null },
				} as unknown as ExtensionToolContext,
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
				{
					cwd: process.cwd(),
					sessionManager: { getLeafId: () => null },
				} as unknown as ExtensionToolContext,
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
