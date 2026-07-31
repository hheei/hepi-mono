import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "../../../hepi-basics/src/core/index.js";
import { assertVisibleWidth, fakeTheme, stripAnsi } from "../../../hepi-basics/test/helpers.js";
import { createBtwComponent } from "../../component.js";
import { createBtwTurn } from "../../model.js";

const theme = fakeTheme() as unknown as Theme;

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function harness(rows = 30, question = "current question") {
	let terminalRows = rows;
	const history = [createBtwTurn("previous question", assistant("previous answer"), 1)];
	const state = { renders: 0, clears: 0, done: 0 };
	const component = createBtwComponent({
		question,
		history,
		theme,
		host: {
			requestRender: () => {
				state.renders++;
			},
			getTerminalRows: () => terminalRows,
		},
		done: () => {
			state.done++;
		},
		onClearHistory: () => {
			state.clears++;
		},
	});
	return {
		component,
		state,
		setRows: (value: number) => {
			terminalRows = value;
		},
	};
}

function plain(component: { render(width: number): string[] }, width: number): string {
	return component.render(width).map(stripAnsi).join("\n");
}

describe("BTW component", () => {
	test("renders pending, answer, and error states", () => {
		const pending = harness().component;
		expect(plain(pending, 80)).toContain("Waiting for the model...");
		const answer = harness().component;
		answer.setAnswer("the answer");
		expect(plain(answer, 80)).toContain("Answer");
		expect(plain(answer, 80)).toContain("the answer");
		const error = harness().component;
		error.setError("provider failed");
		expect(plain(error, 80)).toContain("Error: provider failed");
	});

	test("renders a responsive, stable-height rounded frame", () => {
		const { component, setRows } = harness(30);
		for (const width of [40, 80, 120]) {
			const lines = component.render(width).map(stripAnsi);
			expect(lines).toHaveLength(15);
			expect(lines[0]?.startsWith("╭─ BTW ")).toBe(true);
			expect(lines.at(-2)?.startsWith("│ ↕ scroll")).toBe(true);
			expect(lines.at(-1)?.startsWith("╰")).toBe(true);
			expect(lines.some((line) => line.startsWith("├"))).toBe(false);
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
		}
		setRows(20);
		expect(component.render(80)).toHaveLength(12);
		setRows(50);
		expect(component.render(80)).toHaveLength(22);
		setRows(10);
		expect(component.render(80)).toHaveLength(8);
	});

	test("renders history without starting a question", () => {
		const withHistory = harness(30, "").component;
		expect(plain(withHistory, 80)).toContain("previous question");
		expect(plain(withHistory, 80)).not.toContain("Waiting for the model...");
		withHistory.handleInput?.("x");
		expect(plain(withHistory, 80)).toContain("No BTW history yet.");
	});

	test("keeps every row within 40, 80, and 120 columns", () => {
		const component = harness().component;
		component.setAnswer("long ".repeat(300));
		for (const width of [40, 80, 120]) assertVisibleWidth(component.render(width), width);
	});

	test("scrolls tall and long content with stable top and bottom bounds", () => {
		const { component, setRows } = harness(10);
		const answerRows = Array.from({ length: 250 }, (_, index) => `answer row ${index}`);
		component.setAnswer(answerRows.join("\n"));
		setRows(10);
		const bottom = component.render(40);
		component.handleInput?.("\x1b[B");
		expect(component.render(40)).toEqual(bottom);

		let previous = bottom;
		let top = bottom;
		let reachedTop = false;
		const maximumUpSteps = answerRows.length + bottom.length * 2;
		for (let index = 0; index < maximumUpSteps; index++) {
			component.handleInput?.("\x1b[A");
			const current = component.render(40);
			if (
				current.length === previous.length &&
				current.every((row, rowIndex) => row === previous[rowIndex])
			) {
				top = current;
				reachedTop = true;
				break;
			}
			previous = current;
		}
		expect(reachedTop).toBe(true);
		component.handleInput?.("\x1b[A");
		expect(component.render(40)).toEqual(top);
		assertVisibleWidth(top, 40);
	});

	test("close, escape, dispose, and double close call done exactly once", () => {
		for (const action of ["close", "escape", "dispose"] as const) {
			const { component, state } = harness();
			if (action === "escape") component.handleInput?.("\x1b");
			else component[action]();
			component.close();
			component.dispose();
			expect(state.done).toBe(1);
		}
	});

	test("arrows and x clear history and request renders", () => {
		const { component, state } = harness();
		component.render(40);
		component.handleInput?.("\x1b[A");
		component.handleInput?.("\x1b[B");
		expect(state.renders).toBe(2);
		component.handleInput?.("x");
		expect(state.clears).toBe(1);
		expect(state.renders).toBe(3);
		expect(plain(component, 80)).not.toContain("previous question");
	});

	test("render remains valid after terminal resize", () => {
		const { component, setRows } = harness(12);
		component.setAnswer("answer ".repeat(100));
		assertVisibleWidth(component.render(40), 40);
		setRows(30);
		assertVisibleWidth(component.render(120), 120);
		setRows(8);
		assertVisibleWidth(component.render(40), 40);
	});
});
