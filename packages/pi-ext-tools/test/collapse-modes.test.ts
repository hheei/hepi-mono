import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
	type Theme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { AUTO_COLLAPSE_DELAY_MS, createToolTui, type ToolTui } from "@hheei/pi-ext-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerTools } from "../src/tools.js";

const BODY_LINE = "readable body line 30";
const temporaryPaths: string[] = [];

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "hepi-collapse-"));
	temporaryPaths.push(cwd);
	const lines = Array.from({ length: 30 }, (_, index) =>
		index === 29 ? BODY_LINE : `readable body line ${index + 1}`,
	);
	await writeFile(join(cwd, "big.txt"), `${lines.join("\n")}\n`, "utf8");
	return cwd;
}

function harness(): { readonly pi: ExtensionAPI; readonly tools: ToolDefinition[] } {
	const tools: ToolDefinition[] = [];
	return {
		pi: {
			events: {},
			on: (): void => undefined,
			registerTool: (tool: ToolDefinition): void => {
				tools.push(tool);
			},
			getActiveTools: (): readonly string[] => ["read"],
			setActiveTools: (): void => undefined,
		} as unknown as ExtensionAPI,
		tools,
	};
}

async function mounted(
	tui: ToolTui,
	name: string,
	args: Record<string, unknown>,
	updates?: AgentToolResult<unknown>[],
): Promise<{ readonly component: ToolExecutionComponent; readonly cwd: string }> {
	const cwd = await fixture();
	const host = harness();
	registerTools(host.pi, undefined, tui);
	const tool = host.tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`${name} was not registered`);
	const component = new ToolExecutionComponent(
		name,
		`${name}-collapse`,
		args,
		undefined,
		tool,
		{ requestRender: (): void => undefined } as unknown as TUI,
		cwd,
	);
	tui.beginTrace();
	component.markExecutionStarted();
	const result = await tool.execute(
		`${name}-collapse`,
		args,
		undefined,
		updates === undefined ? undefined : (update) => updates.push(update),
		{
			cwd,
			sessionManager: {
				getSessionId: (): string => "ext-tools-collapse-test",
				getSessionFile: (): undefined => undefined,
			},
		} as unknown as ExtensionContext,
	);
	component.updateResult({ ...result, isError: false });
	return { component, cwd };
}

function rendered(component: ToolExecutionComponent): string {
	return stripTerminalSequences(component.render(100).join("\n"));
}

describe("tool frame collapse modes", () => {
	test("on mode collapses a registered long tool on the first completed frame", async (): Promise<void> => {
		initTheme("dark");
		const tui = createToolTui();
		tui.setToolCollapseMode("on");
		const { component } = await mounted(tui, "read", { path: "big.txt" });
		const lines = rendered(component).split("\n");
		expect(lines.join("\n")).toContain("read");
		expect(lines.join("\n")).not.toContain(BODY_LINE);
		expect(lines.filter((line) => line.trim() !== "")).toHaveLength(2);
	});

	test("auto mode keeps the body until the delay elapses", async (): Promise<void> => {
		vi.useFakeTimers();
		try {
			initTheme("dark");
			const tui = createToolTui();
			tui.setToolCollapseMode("auto");
			const { component } = await mounted(tui, "read", { path: "big.txt" });
			const live = rendered(component);
			expect(live).toContain(BODY_LINE);
			expect(live.split("\n").length).toBeGreaterThan(2);

			vi.advanceTimersByTime(AUTO_COLLAPSE_DELAY_MS);
			const collapsed = rendered(component).split("\n");
			expect(collapsed.join("\n")).not.toContain(BODY_LINE);
			expect(collapsed.filter((line) => line.trim() !== "")).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	test("on mode leaves a tool without longOutput expanded", async (): Promise<void> => {
		initTheme("dark");
		const tui = createToolTui();
		tui.setToolCollapseMode("on");
		const { component } = await mounted(tui, "list_tasks", {});
		expect(rendered(component).split("\n").length).toBeGreaterThan(2);
	});

	test("on mode shows a completed bash frame as header plus footer without streaming", async (): Promise<void> => {
		initTheme("dark");
		const tui = createToolTui();
		tui.setToolCollapseMode("on");
		const updates: AgentToolResult<unknown>[] = [];
		const { component } = await mounted(tui, "bash", { command: "echo one\necho two" }, updates);
		expect(updates).toHaveLength(0);
		const notes = rendered(component)
			.split("\n")
			.filter((line) => line.trim() !== "");
		expect(notes).toHaveLength(2);
		expect(notes[0]).toContain("echo one; echo two");
		expect(notes[1]).toMatch(/exit 0/);
	});

	test("flattens a multi-line bash command into one header line", async (): Promise<void> => {
		initTheme("dark");
		const tui = createToolTui();
		const host = harness();
		registerTools(host.pi, undefined, tui);
		const bash = host.tools.find((candidate) => candidate.name === "bash");
		if (bash === undefined) throw new Error("bash was not registered");
		const plainTheme = {
			bg: (_role: string, text: string): string => text,
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		} as Theme;
		const header = bash
			.renderCall?.({ command: "first line\nsecond line\nthird line" }, plainTheme, {
				isError: false,
				isPartial: true,
				lastComponent: undefined,
			} as never)
			.render(200);
		expect(header).toHaveLength(1);
		expect(header?.[0]).toContain("first line; second line; third line");
	});

	test("keeps a long bash command on one truncated header row", async (): Promise<void> => {
		initTheme("dark");
		const tui = createToolTui();
		const host = harness();
		registerTools(host.pi, undefined, tui);
		const bash = host.tools.find((candidate) => candidate.name === "bash");
		if (bash === undefined) throw new Error("bash was not registered");
		const plainTheme = {
			bg: (_role: string, text: string): string => text,
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		} as Theme;
		const command = `docker run --rm -v /tmp:/tmp alpine sh -c "echo one; echo two"`;
		const header = bash
			.renderCall?.({ command }, plainTheme, {
				isError: false,
				isPartial: true,
				lastComponent: undefined,
			} as never)
			.render(40);
		expect(header).toHaveLength(1);
		expect(header?.[0]).toContain("…");
		expect(stripTerminalSequences(header?.[0] ?? "").endsWith("…")).toBe(true);
	});

	test("keeps every uncollapsed frame row inside a narrow terminal", async (): Promise<void> => {
		initTheme("dark");
		const tui = createToolTui();
		const host = harness();
		registerTools(host.pi, undefined, tui);
		const grep = host.tools.find((candidate) => candidate.name === "grep");
		if (grep === undefined) throw new Error("grep was not registered");
		const plainTheme = {
			bg: (_role: string, text: string): string => text,
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		} as Theme;
		const context = {
			isError: false,
			isPartial: false,
			lastComponent: undefined,
			toolCallId: "grep-uncollapsed",
			executionStarted: true,
			expanded: false,
			invalidate: (): void => undefined,
		};
		const args = { pattern: "needle", path: "a/very/long/search/path" };
		const result = {
			content: [{ type: "text" as const, text: "match" }],
			details: {
				format: "canonical-grep",
				display: [] as unknown[],
				totalMatched: 1_234,
				totalFiles: 123,
				totalLines: 4_000,
				durationMs: 1_234,
			},
		};
		const rows = [
			...(grep.renderCall?.(args, plainTheme, context as never).render(40) ?? []),
			...(grep
				.renderResult?.(result, { expanded: false, isPartial: false }, plainTheme, context as never)
				.render(40) ?? []),
		];
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((row) => visibleWidth(row) <= 40)).toBe(true);
	});

	test("collapses a narrow grep frame to a truncated header and summary", async (): Promise<void> => {
		initTheme("dark");
		const tui = createToolTui();
		const host = harness();
		registerTools(host.pi, undefined, tui);
		const grep = host.tools.find((candidate) => candidate.name === "grep");
		if (grep === undefined) throw new Error("grep was not registered");
		const plainTheme = {
			bg: (_role: string, text: string): string => text,
			fg: (_role: string, text: string): string => text,
			bold: (text: string): string => text,
		} as Theme;
		const context = {
			isError: false,
			isPartial: false,
			lastComponent: undefined,
			toolCallId: "grep-narrow",
			executionStarted: true,
			expanded: false,
			invalidate: (): void => undefined,
		};
		const args = { pattern: "very-long-needle", path: "a/very/long/search/path" };
		grep.renderCall?.(args, plainTheme, context as never);
		tui.beginTrace();
		const result = {
			content: [{ type: "text" as const, text: "match" }],
			details: {
				format: "canonical-grep",
				display: [] as unknown[],
				totalMatched: 1_234,
				totalFiles: 123,
				totalLines: 4_000,
				durationMs: 1_234,
			},
		};
		const rows = [
			...(grep.renderCall?.(args, plainTheme, context as never).render(40) ?? []),
			...(grep
				.renderResult?.(result, { expanded: false, isPartial: false }, plainTheme, context as never)
				.render(40) ?? []),
		];
		expect(rows).toHaveLength(2);
		expect(stripTerminalSequences(rows[0] ?? "")).toContain("…");
		expect(stripTerminalSequences(rows[1] ?? "")).toContain("…");
	});

	test("keeps the model-visible result identical", async (): Promise<void> => {
		initTheme("dark");
		const tui = createToolTui();
		tui.setToolCollapseMode("on");
		const cwd = await fixture();
		const host = harness();
		registerTools(host.pi, undefined, tui);
		const read = host.tools.find((candidate) => candidate.name === "read");
		if (read === undefined) throw new Error("read was not registered");
		const result = await read.execute("read-collapse", { path: "big.txt" }, undefined, undefined, {
			cwd,
			sessionManager: {
				getSessionId: (): string => "ext-tools-collapse-test",
				getSessionFile: (): undefined => undefined,
			},
		} as unknown as ExtensionContext);
		const text = result.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("");
		expect(text).toContain(BODY_LINE);
	});
});
