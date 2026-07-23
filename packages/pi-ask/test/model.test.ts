import { describe, expect, test } from "bun:test";
import {
	ASK_LIMITS,
	ASK_OTHER_LABEL,
	answersFromState,
	freshAskState,
	normalizeAskParams,
	reduceAsk,
	validateAskCustomAnswer,
} from "../src/model.js";

const input = {
	questions: [
		{
			id: "backend",
			question: "Backend?",
			options: [{ label: "SQLite" }, { label: "Postgres" }],
			recommended: 1,
		},
	],
};

describe("ask model", () => {
	test("normalizes and deep-isolates", () => {
		const source = {
			context: "  one\n two ",
			questions: [
				{
					id: " q_1 ",
					question: " Pick ",
					options: [{ label: " A " }, { label: " B ", description: " desc " }],
				},
			],
		};
		const result = normalizeAskParams(source);
		expect(result).toEqual({
			context: "one\n two",
			questions: [
				{
					id: "q_1",
					question: "Pick",
					options: [{ label: "A" }, { label: "B", description: "desc" }],
					multi: false,
				},
			],
		});
		(source.questions[0]!.options[0]!.label as string) = "changed";
		expect(result.questions[0]!.options[0]!.label).toBe("A");
	});
	test("enforces counts, identity, reserved labels and bounds", () => {
		for (const questions of [[], Array.from({ length: 5 }, () => input.questions[0])])
			expect(() => normalizeAskParams({ questions })).toThrow();
		expect(() =>
			normalizeAskParams({ questions: [{ ...input.questions[0], options: [{ label: "A" }] }] }),
		).toThrow();
		expect(() =>
			normalizeAskParams({
				questions: [{ ...input.questions[0], options: [{ label: "A" }, { label: "a" }] }],
			}),
		).toThrow();
		expect(() =>
			normalizeAskParams({
				questions: [
					{ ...input.questions[0], options: [{ label: ASK_OTHER_LABEL }, { label: "B" }] },
				],
			}),
		).toThrow();
		expect(() =>
			normalizeAskParams({ questions: [{ ...input.questions[0], recommended: 2 }] }),
		).toThrow();
		expect(() =>
			normalizeAskParams({ questions: [{ ...input.questions[0], recommended: "0" }] }),
		).toThrow();
		expect(() => validateAskCustomAnswer(" ")).toThrow();
		expect(() =>
			validateAskCustomAnswer("x".repeat(ASK_LIMITS.maxCustomAnswerLength + 1)),
		).toThrow();
	});
	test("recommendation sets focus only", () => {
		const state = freshAskState(normalizeAskParams(input));
		expect(state.focusedOption).toEqual([1]);
		expect(state.answers[0]).toEqual({ answered: false, selected: [] });
	});
	test("single select advances first answer but edits stay", () => {
		const questionnaire = normalizeAskParams({
			questions: [
				input.questions[0],
				{ id: "second", question: "Second?", options: [{ label: "X" }, { label: "Y" }] },
			],
		});
		let state = freshAskState(questionnaire);
		state = reduceAsk(state, questionnaire, { type: "select_option" });
		expect(state.questionIndex).toBe(1);
		state = reduceAsk(state, questionnaire, { type: "move_tab", delta: -1 });
		state = reduceAsk(state, questionnaire, { type: "move_option", delta: 1 });
		state = reduceAsk(state, questionnaire, { type: "select_option" });
		expect(state.questionIndex).toBe(0);
		expect(answersFromState(state, questionnaire)[0]!.selected[0]!.index).toBe(1);
	});
	test("custom and terminal semantics", () => {
		const questionnaire = normalizeAskParams(input);
		let state = freshAskState(questionnaire);
		state = reduceAsk(state, questionnaire, { type: "move_option", delta: 1 });
		state = reduceAsk(state, questionnaire, { type: "open_custom" });
		state = reduceAsk(state, questionnaire, { type: "set_custom_draft", value: " own " });
		state = reduceAsk(state, questionnaire, { type: "commit_custom" });
		expect(state.mode).toBe("review");
		state = reduceAsk(state, questionnaire, { type: "submit" });
		expect(state.terminal).toBe("submitted");
		expect(reduceAsk(state, questionnaire, { type: "cancel" })).toBe(state);
	});
	test("multi-select preserves custom answer while toggling options", () => {
		const questionnaire = normalizeAskParams({
			questions: [{ ...input.questions[0], multi: true }],
		});
		let state = freshAskState(questionnaire);
		state = reduceAsk(state, questionnaire, { type: "move_option", delta: -1 });
		state = reduceAsk(state, questionnaire, { type: "select_option" });
		state = reduceAsk(state, questionnaire, { type: "move_tab", delta: -1 });
		state = reduceAsk(state, questionnaire, { type: "open_custom" });
		state = reduceAsk(state, questionnaire, { type: "set_custom_draft", value: "Other backend" });
		state = reduceAsk(state, questionnaire, { type: "commit_custom" });
		state = reduceAsk(state, questionnaire, { type: "move_option", delta: 1 });
		state = reduceAsk(state, questionnaire, { type: "select_option" });
		expect(answersFromState(state, questionnaire)[0]).toMatchObject({ custom: "Other backend" });
		expect(answersFromState(state, questionnaire)[0]?.selected).toEqual([
			{ index: 0, label: "SQLite" },
			{ index: 1, label: "Postgres" },
		]);
	});
});
