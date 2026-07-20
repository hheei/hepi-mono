import {
	ASK_OTHER_LABEL,
	type AskAnswer,
	type AskInteractionResult,
	type AskQuestion,
	type AskQuestionnaire,
	normalizeAskParams,
	validateAskCustomAnswer,
} from "./model.js";

export interface DialogOptions {
	readonly signal?: AbortSignal;
}
export interface DialogUI {
	select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
}
export function hasDialogUI(ui: unknown): ui is DialogUI {
	return (
		typeof ui === "object" &&
		ui !== null &&
		typeof (ui as DialogUI).select === "function" &&
		typeof (ui as DialogUI).input === "function"
	);
}

function wireOption(question: AskQuestion, index: number): string {
	const option = question.options[index]!;
	return `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`;
}
function wireOptions(question: AskQuestion): string[] {
	return [
		...question.options.map((_, index) => wireOption(question, index)),
		`${question.options.length + 1}. ${ASK_OTHER_LABEL}`,
	];
}
function cancelled(questionnaire: AskQuestionnaire): AskInteractionResult {
	return {
		status: "cancelled",
		details: { questionnaire, answers: [], status: "cancelled", cancelled: true },
	};
}
function aborted(questionnaire: AskQuestionnaire): AskInteractionResult {
	return {
		status: "aborted",
		details: { questionnaire, answers: [], status: "aborted", cancelled: false },
	};
}
function checkAbort(
	signal: AbortSignal | undefined,
	questionnaire: AskQuestionnaire,
): AskInteractionResult | undefined {
	return signal?.aborted ? aborted(questionnaire) : undefined;
}
function hostError(): Error {
	return new Error("Host returned an unsupported Ask option");
}

async function customAnswer(
	ui: DialogUI,
	title: string,
	signal: AbortSignal | undefined,
): Promise<{ value?: string; cancelled: boolean; invalid: boolean }> {
	const raw = await ui.input(title, "Type your answer", { signal });
	if (raw === undefined) return { cancelled: true, invalid: false };
	try {
		return { value: validateAskCustomAnswer(raw), cancelled: false, invalid: false };
	} catch {
		return { cancelled: false, invalid: true };
	}
}

async function collectQuestion(
	ui: DialogUI,
	question: AskQuestion,
	signal: AbortSignal | undefined,
): Promise<AskAnswer | undefined> {
	const offered = wireOptions(question);
	if (!question.multi) {
		const choice = await ui.select(question.question, offered, { signal });
		if (choice === undefined) return undefined;
		const other = offered[offered.length - 1]!;
		if (choice === other) {
			const custom = await customAnswer(ui, question.question, signal);
			if (custom.cancelled) return undefined;
			if (custom.invalid) throw new Error("Host returned an invalid custom Ask answer");
			return { id: question.id, question: question.question, selected: [], custom: custom.value };
		}
		const index = offered.indexOf(choice);
		if (index < 0 || index >= question.options.length) throw hostError();
		return {
			id: question.id,
			question: question.question,
			selected: [{ index, label: question.options[index]!.label }],
		};
	}

	const selected: number[] = [];
	let custom: string | undefined;
	const finish = "Finish selection";
	while (true) {
		const choices = [...offered, finish];
		const choice = await ui.select(question.question, choices, { signal });
		if (choice === undefined) return undefined;
		if (choice === finish)
			return {
				id: question.id,
				question: question.question,
				selected: selected.map((index) => ({ index, label: question.options[index]!.label })),
				...(custom === undefined ? {} : { custom }),
			};
		if (choice === offered[offered.length - 1]) {
			const answer = await customAnswer(ui, question.question, signal);
			if (answer.cancelled) return undefined;
			if (answer.invalid) throw new Error("Host returned an invalid custom Ask answer");
			custom = answer.value;
			continue;
		}
		const index = offered.indexOf(choice);
		if (index < 0 || index >= question.options.length) throw hostError();
		const position = selected.indexOf(index);
		if (position < 0) selected.push(index);
		else selected.splice(position, 1);
	}
}

function summary(answers: readonly AskAnswer[]): string {
	return answers
		.map((answer) => {
			const choices = answer.selected.map((selection) => selection.label);
			if (answer.custom !== undefined) choices.push(`Other: ${answer.custom}`);
			if (!choices.length) choices.push("None selected");
			return `${answer.id}: ${choices.join("; ")}`;
		})
		.join("\n");
}

export async function runAskFallback(
	input: AskQuestionnaire,
	ui: DialogUI,
	signal?: AbortSignal,
): Promise<AskInteractionResult> {
	const questionnaire = normalizeAskParams(input);
	if (!hasDialogUI(ui)) throw new Error("Ask dialog UI is unsupported");
	let answers: AskAnswer[] = [];
	while (true) {
		const early = checkAbort(signal, questionnaire);
		if (early) return early;
		answers = [];
		for (const question of questionnaire.questions) {
			const answer = await collectQuestion(ui, question, signal);
			const after = checkAbort(signal, questionnaire);
			if (after) return after;
			if (!answer) return cancelled(questionnaire);
			answers.push(answer);
		}
		const review = await ui.select(
			`Review answers\n${summary(answers)}`,
			["Submit answers", "Start over", "Cancel"],
			{ signal },
		);
		const after = checkAbort(signal, questionnaire);
		if (after) return after;
		if (review === undefined || review === "Cancel") return cancelled(questionnaire);
		if (review === "Start over") continue;
		if (review !== "Submit answers") throw hostError();
		return {
			status: "submitted",
			details: { questionnaire, answers, status: "submitted", cancelled: false },
		};
	}
}

export const askWithDialogFallback = runAskFallback;
