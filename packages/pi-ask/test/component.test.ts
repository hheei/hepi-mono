import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { assertVisibleWidth, stripAnsi } from "../../pi-basics/test/helpers.js";
import { createAskComponent, formatAskReviewAnswer } from "../src/component.js";
import { normalizeAskParams } from "../src/model.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;
const taggedTheme = {
	...theme,
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;
const questionnaire = normalizeAskParams({
	context: "Choose carefully",
	questions: [
		{
			id: "one",
			question: "First question",
			recommended: 0,
			options: [{ label: "Alpha", description: "A long description" }, { label: "Beta" }],
		},
		{
			id: "two",
			question: "Second question",
			multi: true,
			options: [{ label: "Gamma" }, { label: "Delta" }],
		},
	],
});
function harness(rows = 30) {
	const done: unknown[] = [];
	const host = {
		renders: 0,
		requestRender() {
			this.renders++;
		},
		getTerminalRows: () => rows,
	};
	const component = createAskComponent({
		questionnaire,
		host,
		theme,
		done: (result) => done.push(result),
	});
	return { component, host, done };
}
function plain(component: { render(width: number): string[] }, width = 40): string {
	return component.render(width).map(stripAnsi).join("\n");
}

describe("Ask component", () => {
	test("renders tabs, title, neutral cursor, and width-safe sticky footer", () => {
		const { component } = harness();
		const lines = component.render(40);
		expect(plain(component)).toContain("☐ #1");
		expect(plain(component)).toContain("☐ #2");
		expect(plain(component)).toContain("≡ Review");
		expect(plain(component)).toContain("? Ask · Question #1");
		const optionLines = plain(component)
			.split("\n")
			.map((line) => line.trimEnd());
		expect(optionLines).toContain("→ Alpha (Recommended)");
		expect(optionLines).toContain("  Beta");
		expect(optionLines).toContain("  Other (type your own)");
		expect(plain(component)).toContain("↵ select");
		assertVisibleWidth(lines, 40);
	});

	test("select advances first unanswered, edits answered in place, and review gates submit", () => {
		const { component, done } = harness();
		component.handleInput?.("\r");
		expect(plain(component)).toContain("? Ask · Question #2");
		component.handleInput?.("\x1b[D");
		expect(plain(component)).toContain("? Ask · Question #1");
		component.handleInput?.("\r");
		expect(plain(component)).toContain("? Ask · Question #1");
		component.handleInput?.("\x1b[C");
		component.handleInput?.("\r");
		expect(plain(component)).toContain("? Ask · Review");
		component.handleInput?.("\r");
		expect(done).toHaveLength(1);
		expect(done[0]).toMatchObject({ status: "submitted" });
	});

	test("review wraps content and arrows scroll its right scrollbar", () => {
		const longQuestion =
			"Which deployment strategy should be used for this unusually detailed scenario?";
		const longAnswer = "Use production-safe deployment strategy with safeguards";
		const done: unknown[] = [];
		let terminalRows = 30;
		const component = createAskComponent({
			questionnaire: normalizeAskParams({
				questions: [
					{
						id: "deployment",
						question: longQuestion,
						options: [{ label: longAnswer }, { label: "No" }],
					},
				],
			}),
			host: { requestRender() {}, getTerminalRows: () => terminalRows },
			theme,
			done: (result) => done.push(result),
		});
		component.handleInput?.("\r");
		const expanded = component.render(40);
		const expandedLines = expanded.map(stripAnsi).map((line) => line.trimEnd());
		const questionContinuation = expandedLines.find((line) => line.includes("scenario?"));
		const answerContinuation = expandedLines.find((line) => line.includes("safeguards"));
		expect(questionContinuation?.startsWith("scenario?")).toBe(true);
		expect(answerContinuation?.startsWith("  ")).toBe(true);
		expect(expandedLines.some((line) => line.includes("…"))).toBe(false);
		expect(expandedLines.some((line) => line.includes("↕ scroll"))).toBe(true);
		expect(expanded.map(stripAnsi).some((line) => /[█│]$/.test(line))).toBe(false);
		assertVisibleWidth(expanded, 40);

		terminalRows = 12;
		const top = component.render(40);
		expect(top.map(stripAnsi).some((line) => /[█│]$/.test(line))).toBe(true);
		component.handleInput?.("\x1b[A");
		expect(component.render(40)).toEqual(top);
		component.handleInput?.("\x1b[B");
		expect(component.render(40)).not.toEqual(top);
		component.handleInput?.("\r");
		expect(done[0]).toMatchObject({ status: "submitted" });
	});

	test("review uses semantic colors for questions, answers, glyphs, and footer", () => {
		const component = createAskComponent({
			questionnaire: normalizeAskParams({
				questions: [
					{
						id: "deployment",
						question: "Deployment?",
						options: [{ label: "Yes" }, { label: "No" }],
					},
				],
			}),
			host: { requestRender() {}, getTerminalRows: () => 30 },
			theme: taggedTheme,
			done() {},
		});
		component.handleInput?.("\r");
		const output = component.render(120).join("\n");
		expect(output).toContain("<dim>#1 Deployment?</dim>");
		expect(output).toContain("<borderAccent>☑</borderAccent> <border>Yes</border>");
		expect(output).toContain("<dim>↕ scroll · ↔ switch · ↵ submit · ⎋ cancel</dim>");
		expect(output).toContain("<text>╭");
		expect(output).toContain("<accent>╭");
		expect(output).toContain("<accent>╯");
		expect(output).toContain("<text>│ ☑ #1 │</text>");
		expect(output).toContain("<accent>│ ≡ Review │</accent>");
	});

	test("review rejects an inconsistent selected option index", () => {
		const question = questionnaire.questions[0];
		if (question === undefined) throw new Error("Expected fixture question");

		expect(() =>
			formatAskReviewAnswer(question, { answered: true, selected: [question.options.length] }),
		).toThrow("Ask option state is inconsistent");
	});

	test("selected row keeps answer color over cursor color and uses arrow slot", () => {
		const colorTheme = taggedTheme;
		const done: unknown[] = [];
		const component = createAskComponent({
			questionnaire,
			host: { requestRender() {}, getTerminalRows: () => 30 },
			theme: colorTheme,
			done: (r) => done.push(r),
		});
		component.handleInput?.("\r");
		const output = component.render(80).join("\n");
		expect(output).toContain("<accent>");
		expect(output).not.toContain("<warning>→ Alpha");
	});

	test("question Esc skips, review Esc cancels, abort and dispose settle once", () => {
		const first = harness();
		first.component.handleInput?.("\x1b");
		expect(first.done).toHaveLength(0);
		first.component.handleInput?.("\x1b");
		expect(first.done).toHaveLength(0);
		first.component.handleInput?.("\x1b");
		expect(first.done).toHaveLength(1);
		expect(first.done[0]).toMatchObject({ status: "cancelled" });

		const controller = new AbortController();
		const done: unknown[] = [];
		const component = createAskComponent({
			questionnaire,
			host: { requestRender() {}, getTerminalRows: () => 20 },
			theme,
			signal: controller.signal,
			done: (r) => done.push(r),
		});
		controller.abort();
		component.dispose();
		component.handleInput?.("\r");
		expect(done).toHaveLength(1);
		expect(done[0]).toMatchObject({ status: "aborted" });
	});

	test("custom editor is bounded and commits Other", () => {
		const { component } = harness();
		component.handleInput?.("\x1b[B");
		component.handleInput?.("\x1b[B");
		component.handleInput?.("\r");
		component.handleInput?.("hello");
		expect(plain(component)).toContain("hello");
		component.handleInput?.("\r");
		expect(plain(component)).toContain("? Ask · Question #2");
	});
});
