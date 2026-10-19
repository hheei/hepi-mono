import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ToolPresentationContext, ToolPresentationSection } from "@hheei/pi-ext-core";
import { describe, expect, test } from "vitest";
import {
	createPythonEvalPresentation,
	type EvalRow,
	type EvalToolDetails,
	PYTHON_EVAL_DETAILS_FORMAT,
	readEvalDetails,
} from "../src/presentation.js";

/** A theme that keeps its tokens visible, so a test can assert which token painted what. */
const theme = {
	fg: (token: string, text: string) => `<${token}>${text}`,
	bold: (text: string) => text,
} as unknown as Theme;

function context(overrides: Partial<ToolPresentationContext> = {}): ToolPresentationContext {
	return {
		args: {},
		state: {},
		toolCallId: "call",
		cwd: "/repo",
		invalidate() {},
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		lastComponent: undefined,
		durationMs: 1500,
		outputPad: 0,
		...overrides,
	} as unknown as ToolPresentationContext;
}

function result(
	rows: readonly EvalRow[],
	extra: Partial<EvalToolDetails> = {},
): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: "plain transcript" }],
		details: { format: PYTHON_EVAL_DETAILS_FORMAT, rows, durationMs: 1500, ...extra },
	};
}

/** Every section's content as plain rows, so assertions read as what the frame shows. */
function sectionRows(sections: readonly ToolPresentationSection[] | undefined): string[] {
	const rows: string[] = [];
	for (const section of sections ?? []) {
		const content = section.content;
		if (typeof content === "string") rows.push(stripTerminalSequences(content));
		else if (Array.isArray(content))
			rows.push(...content.map((line) => stripTerminalSequences(line)));
	}
	return rows;
}

function railTokens(
	sections: readonly ToolPresentationSection[] | undefined,
): (string | undefined)[] {
	return (sections ?? []).map((section) => section.railToken);
}

const nestedTool = (name: "read" | "bash", args: unknown, durationMs: number, error?: string) =>
	({
		kind: "tool",
		trace: {
			name,
			args,
			text: "",
			details: undefined,
			durationMs,
			...(error === undefined ? {} : { error }),
		},
	}) as const;

describe("python_eval rich presentation", () => {
	test("the call row names the first code line and the options that change the cell", () => {
		const call = (args: unknown): string =>
			stripTerminalSequences(
				createPythonEvalPresentation(args, undefined, theme, context()).summary,
			);

		expect(call({ code: "x = 1\nprint(x)" })).toBe("x = 1");
		expect(call({ code: "x = 1", reset: true })).toBe("x = 1 · (reset)");
		expect(call({ code: "x = 1", timeout_ms: 250 })).toBe("x = 1 · (timeout 250ms)");
		expect(call({ code: "x = 1", reset: true, timeout_ms: 2000 })).toBe(
			"x = 1 · (reset) · (timeout 2s)",
		);
		expect(call({ code: "   " })).toBe("(empty)");
	});

	test("the result row reports nested call stats and the cell duration", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "tools.read(path='a')" },
			result([
				nestedTool("read", { path: "a" }, 12),
				nestedTool("bash", { command: "ls" }, 30, "boom"),
			]),
			theme,
			context(),
		);
		expect(stripTerminalSequences(presentation.summary)).toBe("1 ok · 1 failed · 1.5s");
		// A container with child rows speaks through them instead of claiming its own status.
		expect(presentation.status).toBe("none");
	});

	test("a cell without nested calls counts its rows and keeps its own status", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "print(1)" },
			result([{ kind: "text", text: "1" }]),
			theme,
			context(),
		);
		expect(stripTerminalSequences(presentation.summary)).toBe("1 row · 1.5s");
		expect(presentation.status).toBe("ok");
	});

	test("a running cell reports running and replaces its call row", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "print(1)" },
			result([{ kind: "text", text: "1" }]),
			theme,
			context({ isPartial: true }),
		);
		expect(presentation.status).toBe("running");
		expect(presentation.replaceCallOnPartial).toBe(true);
	});

	test("the transcript mutes the namespace report and prefixes display and result rows", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "x = 1" },
			result([
				{ kind: "state", text: "state: 1 name · +x" },
				{ kind: "display", text: "{'a': 1}" },
				{ kind: "result", text: "2\n3" },
				{ kind: "text", text: "printed" },
			]),
			theme,
			context(),
		);
		const rows = sectionRows(presentation.sections);
		expect(rows).toContain("<muted>state: 1 name · +x");
		expect(rows).toContain("<dim>display: <dim>{'a': 1}");
		expect(rows).toContain("<dim>result: <dim>2");
		expect(rows).toContain("  <dim>3");
		expect(rows).toContain("<dim>printed");
	});

	test("an error cell paints the transcript as error and the rail as error", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "raise ValueError('nope')" },
			result([{ kind: "text", text: "error: nope" }], { error: "nope" }),
			theme,
			context({ isError: true }),
		);
		expect(presentation.status).toBe("error");
		expect(railTokens(presentation.sections)).toContain("error");
		expect(sectionRows(presentation.sections)).toContain("<error>error: nope");
	});

	test("the code input is highlighted Python on a muted rail, and copied with the transcript", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "print(1)" },
			result([{ kind: "text", text: "1" }]),
			theme,
			context(),
		);
		const tokens = railTokens(presentation.sections);
		expect(tokens[0]).toBe("muted");
		expect(tokens[1]).toBe("success");
		expect(presentation.copy).toEqual({
			primary: "print(1)",
			full: "print(1)\n---\nplain transcript",
		});
	});

	test("a cell with no details degrades to the plain text the tool produced", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "print(1)" },
			{ content: [{ type: "text", text: "1\n2" }], details: {} },
			theme,
			context(),
		);
		expect(sectionRows(presentation.sections)).toEqual(["print(1)", "<dim>1", "<dim>2"]);
		expect(presentation.output).toBe("1\n2");
	});

	test("nested call rows carry the tool name, its argument summary, and its duration", () => {
		const presentation = createPythonEvalPresentation(
			{ code: "tools.read(path='a.txt')" },
			result([
				nestedTool("read", { path: "a.txt" }, 12),
				nestedTool("bash", { command: "ls" }, 30, "boom"),
			]),
			theme,
			context(),
		);
		const rows = sectionRows(presentation.sections);
		expect(rows).toContain("<success>✓ <toolTitle>read <dim>a.txt · 12ms");
		expect(rows).toContain("<error>✗ <toolTitle>bash <dim>ls · 30ms");
		expect(presentation.collapsedRows).toHaveLength(2);
	});
});

describe("python_eval persisted details", () => {
	test("reads only this package's details and drops rows it cannot trust", () => {
		expect(readEvalDetails({ format: "other", rows: [] })).toBeUndefined();
		expect(readEvalDetails(undefined)).toBeUndefined();
		const facts = readEvalDetails({
			format: PYTHON_EVAL_DETAILS_FORMAT,
			rows: [
				{ kind: "text", text: "ok" },
				{ kind: "text", text: 1 },
				{ kind: "tool", trace: { name: "read", args: { path: "a" }, text: "x", durationMs: 5 } },
				{ kind: "tool", trace: { name: "read" } },
			],
			error: "boom",
		});
		expect(facts?.rows).toEqual([
			{ kind: "text", text: "ok" },
			{
				kind: "tool",
				trace: { name: "read", args: { path: "a" }, text: "x", details: undefined, durationMs: 5 },
			},
		]);
		expect(facts?.error).toBe("boom");
	});
});
