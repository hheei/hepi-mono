import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AgentToolResult,
	type ExtensionContext,
	initTheme,
	type ToolDefinition,
	type ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { AUTO_COLLAPSE_DELAY_MS, createToolTui, type ToolTui } from "@hheei/pi-ext-core";
import { describe, expect, test, vi } from "vitest";
import { registerTools } from "../src/tools.js";
import { framedHost, mountTool, toolFor, toolHost } from "./fixtures/harness.js";
import { plainTheme } from "./fixtures/theme.js";
import { temporaryDirectories } from "./fixtures/tmp-dir.js";

const BODY_LINE = "readable body line 4";
const temporaryDirectory = temporaryDirectories("hepi-collapse-");

async function fixture(): Promise<string> {
	const cwd = await temporaryDirectory();
	const lines = Array.from({ length: 4 }, (_, index) =>
		index === 3 ? BODY_LINE : `readable body line ${index + 1}`,
	);
	await writeFile(join(cwd, "big.txt"), `${lines.join("\n")}\n`, "utf8");
	return cwd;
}

async function mounted(
	tui: ToolTui,
	name: string,
	args: Record<string, unknown>,
	updates?: AgentToolResult<unknown>[],
): Promise<{ readonly component: ToolExecutionComponent; readonly cwd: string }> {
	const cwd = await fixture();
	const host = toolHost(["read"]);
	registerTools(host.pi, undefined, tui);
	const tool = toolFor(host.tools, name);
	const component = mountTool(name, `${name}-collapse`, tool, args, cwd);
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
				getLeafId: (): string | null => null,
			},
		} as unknown as ExtensionContext,
	);
	component.updateResult({ ...result, isError: false });
	return { component, cwd };
}

/** The tool frames the extension registers, plus the ToolTui they were framed with. */
function registeredTools(): { readonly tools: readonly ToolDefinition[]; readonly tui: ToolTui } {
	initTheme("dark");
	const { pi, tools, tui } = framedHost(["read"]);
	registerTools(pi, undefined, tui);
	return { tools, tui };
}

function rendered(component: ToolExecutionComponent): string {
	return stripTerminalSequences(component.render(100).join("\n"));
}

describe("tool frame collapse modes", () => {
	test("on mode collapses a registered long tool on the first completed frame", async (): Promise<void> => {
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
		const tui = createToolTui();
		tui.setToolCollapseMode("on");
		const { component } = await mounted(tui, "list_tasks", {});
		expect(rendered(component).split("\n").length).toBeGreaterThan(2);
	});

	test("on mode shows a completed bash frame as header plus footer without streaming", async (): Promise<void> => {
		const tui = createToolTui();
		tui.setToolCollapseMode("on");
		const updates: AgentToolResult<unknown>[] = [];
		const { component } = await mounted(tui, "bash", { command: "echo one\necho two" }, updates);
		expect(updates).toHaveLength(0);
		const notes = rendered(component)
			.split("\n")
			.filter((line) => line.trim() !== "");
		expect(notes).toHaveLength(2);
		// The command lives in the request body, so a collapsed frame shows the facts and the footer.
		expect(notes[0]).toBe("󰄴 bash");
		expect(notes[1]).toMatch(/exit 0/);
	});

	test("keeps a multi-line bash command in its request body under a one-row header", async (): Promise<void> => {
		const { tools } = registeredTools();
		const bash = toolFor(tools, "bash");
		const rowsOf = (command: string, width: number): string[] =>
			bash
				.renderCall?.({ command }, plainTheme, {
					isError: false,
					isPartial: true,
					lastComponent: undefined,
				} as never)
				.render(width) ?? [];

		// The header never repeats the command, however many lines it has.
		const body = rowsOf("first line\nsecond line\nthird line", 200);
		expect(stripTerminalSequences(body[0] ?? "")).toBe("󰪠 bash");
		// The request body below the header keeps the command verbatim, one row per line.
		expect(body.filter((row) => row.includes("─"))).toHaveLength(2);
		expect(body.slice(2, -1)).toEqual(["first line", "second line", "third line"]);

		// A command wider than the terminal wraps inside the body instead of stretching the header.
		const long = `docker run --rm -v /tmp:/tmp alpine sh -c "echo one; echo two"`;
		const narrow = rowsOf(long, 40);
		expect(stripTerminalSequences(narrow[0] ?? "")).toBe("󰪠 bash");
		expect(narrow.join("")).toContain("docker run --rm");
		expect(narrow.every((row) => visibleWidth(row) <= 40)).toBe(true);
	});

	test("keeps every uncollapsed frame row inside a narrow terminal", async (): Promise<void> => {
		const { tools } = registeredTools();
		const grep = toolFor(tools, "grep");
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
		const { tui, tools } = registeredTools();
		const grep = toolFor(tools, "grep");
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
		const { tui, tools } = registeredTools();
		tui.setToolCollapseMode("on");
		const cwd = await fixture();
		const read = toolFor(tools, "read");
		const result = await read.execute("read-collapse", { path: "big.txt" }, undefined, undefined, {
			cwd,
			sessionManager: {
				getSessionId: (): string => "ext-tools-collapse-test",
				getSessionFile: (): undefined => undefined,
				getLeafId: (): string | null => null,
			},
		} as unknown as ExtensionContext);
		const text = result.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("");
		expect(text).toContain(BODY_LINE);
	});
});
