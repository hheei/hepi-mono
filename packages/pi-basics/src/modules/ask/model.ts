export const ASK_OTHER_LABEL = "Other (type your own)";

export const ASK_LIMITS = {
	maxContextLength: 2000,
	maxQuestionLength: 500,
	maxLabelLength: 60,
	maxDescriptionLength: 300,
	maxCustomAnswerLength: 1000,
} as const;

export interface AskOption {
	readonly label: string;
	readonly description?: string;
}
export interface AskQuestion {
	readonly id: string;
	readonly question: string;
	readonly options: readonly AskOption[];
	readonly multi: boolean;
	readonly recommended?: number;
}
export interface AskQuestionnaire {
	readonly context?: string;
	readonly questions: readonly AskQuestion[];
}
export interface AskSelection {
	readonly index: number;
	readonly label: string;
}
export interface AskAnswer {
	readonly id: string;
	readonly question: string;
	readonly selected: readonly AskSelection[];
	readonly custom?: string;
}
export type AskStatus = "submitted" | "cancelled" | "aborted";
export interface AskToolDetails {
	readonly questionnaire: AskQuestionnaire;
	readonly answers: readonly AskAnswer[];
	readonly status: AskStatus;
	readonly cancelled: boolean;
}
export type AskInteractionResult =
	| { readonly status: "submitted"; readonly details: AskToolDetails }
	| { readonly status: "cancelled"; readonly details: AskToolDetails }
	| { readonly status: "aborted"; readonly details: AskToolDetails };

export type AskMode = "question" | "custom" | "review" | "terminal";
export interface AskAnswerDraft {
	readonly answered: boolean;
	readonly selected: readonly number[];
	readonly custom?: string;
}
export interface AskState {
	readonly mode: AskMode;
	readonly questionIndex: number;
	readonly focusedOption: readonly number[];
	readonly answers: readonly AskAnswerDraft[];
	readonly customDraft: string;
	readonly terminal?: "submitted" | "cancelled" | "aborted";
}
export type AskAction =
	| { readonly type: "move_option"; readonly delta: -1 | 1 }
	| { readonly type: "select_option" }
	| { readonly type: "move_tab"; readonly delta: -1 | 1 }
	| { readonly type: "open_custom" }
	| { readonly type: "set_custom_draft"; readonly value: string }
	| { readonly type: "commit_custom" }
	| { readonly type: "cancel_custom" }
	| { readonly type: "submit" }
	| { readonly type: "cancel" }
	| { readonly type: "abort" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function printable(value: unknown, field: string, maxLength: number, allowLf = false): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	const text = value.trim();
	if (!text) throw new Error(`${field} must not be blank`);
	if ([...text].length > maxLength)
		throw new Error(`${field} must be at most ${maxLength} characters`);
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (
			(code < 0x20 && !(allowLf && code === 0x0a)) ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x2028 ||
			code === 0x2029 ||
			(!allowLf && (char === "\n" || char === "\r" || char === "\t"))
		)
			throw new Error(`${field} must be printable text`);
	}
	return text;
}
export function printableSingleLine(value: unknown, field: string, maxLength: number): string {
	return printable(value, field, maxLength);
}
export function normalizedContext(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("context must be a string");
	return printable(
		value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
		"context",
		ASK_LIMITS.maxContextLength,
		true,
	);
}
export function validateAskCustomAnswer(value: unknown): string {
	return printableSingleLine(value, "custom answer", ASK_LIMITS.maxCustomAnswerLength);
}

export function normalizeAskParams(value: unknown): AskQuestionnaire {
	if (!isRecord(value)) throw new Error("Ask params must be an object");
	const rawQuestions = value.questions;
	if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 4)
		throw new Error("questions must contain between 1 and 4 items");
	const ids = new Set<string>();
	const texts = new Set<string>();
	const questions = rawQuestions.map((raw, qi) => {
		if (!isRecord(raw)) throw new Error(`questions[${qi}] must be an object`);
		const id = printableSingleLine(raw.id, `questions[${qi}].id`, 64);
		if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))
			throw new Error(`questions[${qi}].id has invalid format`);
		if (ids.has(id)) throw new Error(`questions[${qi}].id is duplicated`);
		ids.add(id);
		const question = printableSingleLine(
			raw.question,
			`questions[${qi}].question`,
			ASK_LIMITS.maxQuestionLength,
		);
		if (texts.has(question)) throw new Error(`questions[${qi}].question is duplicated`);
		texts.add(question);
		if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 5)
			throw new Error(`questions[${qi}].options must contain between 2 and 5 items`);
		const labels = new Set<string>();
		const options = raw.options.map((option, oi) => {
			if (!isRecord(option)) throw new Error(`questions[${qi}].options[${oi}] must be an object`);
			const label = printableSingleLine(
				option.label,
				`questions[${qi}].options[${oi}].label`,
				ASK_LIMITS.maxLabelLength,
			);
			const folded = label.toLocaleLowerCase();
			if (folded === "other" || folded === ASK_OTHER_LABEL.toLocaleLowerCase())
				throw new Error(`questions[${qi}].options[${oi}].label is reserved: ${ASK_OTHER_LABEL}`);
			if (labels.has(folded))
				throw new Error(`questions[${qi}].options[${oi}].label is duplicated`);
			labels.add(folded);
			const description =
				option.description === undefined
					? undefined
					: printableSingleLine(
							option.description,
							`questions[${qi}].options[${oi}].description`,
							ASK_LIMITS.maxDescriptionLength,
						);
			return description === undefined ? { label } : { label, description };
		});
		const multi = raw.multi === undefined ? false : raw.multi;
		if (typeof multi !== "boolean") throw new Error(`questions[${qi}].multi must be a boolean`);
		let recommended: number | undefined;
		if (raw.recommended !== undefined) {
			if (
				!Number.isSafeInteger(raw.recommended) ||
				(raw.recommended as number) < 0 ||
				(raw.recommended as number) >= options.length
			)
				throw new Error(
					`questions[${qi}].recommended must be an integer between 0 and ${options.length - 1}`,
				);
			recommended = raw.recommended as number;
		}
		return recommended === undefined
			? { id, question, options, multi }
			: { id, question, options, multi, recommended };
	});
	const context = normalizedContext(value.context);
	return context === undefined ? { questions } : { context, questions };
}

export function freshAskState(questionnaire: AskQuestionnaire): AskState {
	return {
		mode: "question",
		questionIndex: 0,
		focusedOption: questionnaire.questions.map((q) => q.recommended ?? 0),
		answers: questionnaire.questions.map(() => ({ answered: false, selected: [] })),
		customDraft: "",
	};
}
type MutableAskState = Omit<AskState, "focusedOption" | "answers"> & {
	focusedOption: number[];
	answers: AskAnswerDraft[];
};
function cloneState(state: AskState): MutableAskState {
	return {
		...state,
		focusedOption: [...state.focusedOption],
		answers: state.answers.map((a) => ({ ...a, selected: [...a.selected] })),
	};
}
function terminal(state: AskState, value: AskState["terminal"]): AskState {
	return { ...cloneState(state), mode: "terminal", terminal: value };
}
function advance(state: AskState, count: number): AskState {
	if (state.questionIndex + 1 >= count) return { ...state, mode: "review" };
	return { ...state, questionIndex: state.questionIndex + 1, mode: "question", customDraft: "" };
}
export function reduceAsk(
	state: AskState,
	questionnaire: AskQuestionnaire,
	action: AskAction,
): AskState {
	if (state.mode === "terminal") return state;
	const next = cloneState(state);
	if (action.type === "abort") return terminal(state, "aborted");
	if (action.type === "cancel")
		return state.mode === "review"
			? terminal(state, "cancelled")
			: state.mode === "custom"
				? { ...state, mode: "question", customDraft: "" }
				: advance(state, questionnaire.questions.length);
	if (state.mode === "custom") {
		if (action.type === "set_custom_draft") return { ...state, customDraft: action.value };
		if (action.type === "cancel_custom") return { ...state, mode: "question", customDraft: "" };
		if (action.type === "commit_custom") {
			let custom: string;
			try {
				custom = validateAskCustomAnswer(state.customDraft);
			} catch {
				return state;
			}
			const answers = [...state.answers];
			answers[state.questionIndex] = {
				answered: true,
				selected: [...answers[state.questionIndex]!.selected],
				custom,
			};
			const result = { ...state, answers, customDraft: "" };
			return state.answers[state.questionIndex]!.answered
				? { ...result, mode: "question" }
				: advance({ ...result, mode: "question" }, questionnaire.questions.length);
		}
		return state;
	}
	if (state.mode === "review") {
		if (action.type === "submit" && state.answers.every((a) => a.answered))
			return terminal(state, "submitted");
		if (action.type === "move_tab") {
			const target = Math.max(
				0,
				Math.min(questionnaire.questions.length, questionnaire.questions.length + action.delta),
			);
			return target === questionnaire.questions.length
				? state
				: { ...state, mode: "question", questionIndex: target };
		}
		return state;
	}
	if (action.type === "move_option") {
		const max = questionnaire.questions[state.questionIndex]!.options.length;
		next.focusedOption[state.questionIndex] = Math.max(
			0,
			Math.min(max, next.focusedOption[state.questionIndex]! + action.delta),
		);
		return next;
	}
	if (action.type === "move_tab") {
		const target = Math.max(
			0,
			Math.min(questionnaire.questions.length, state.questionIndex + action.delta),
		);
		return target === questionnaire.questions.length
			? { ...state, mode: "review" }
			: { ...state, questionIndex: target, mode: "question" };
	}
	if (
		action.type === "open_custom" ||
		(action.type === "select_option" &&
			state.focusedOption[state.questionIndex] ===
				questionnaire.questions[state.questionIndex]!.options.length)
	)
		return { ...state, mode: "custom", customDraft: "" };
	if (action.type === "select_option") {
		const q = questionnaire.questions[state.questionIndex]!;
		const index = state.focusedOption[state.questionIndex]!;
		const old = state.answers[state.questionIndex]!;
		const selected = q.multi
			? old.selected.includes(index)
				? old.selected.filter((x) => x !== index)
				: [...old.selected, index]
			: [index];
		next.answers[state.questionIndex] = {
			answered: true,
			selected,
			...(q.multi && old.custom === undefined ? {} : q.multi ? { custom: old.custom } : {}),
		};
		return old.answered ? next : advance(next, questionnaire.questions.length);
	}
	if (action.type === "set_custom_draft") return { ...state, customDraft: action.value };
	if (action.type === "commit_custom") return state;
	if (action.type === "submit") return state;
	return next;
}
export function answersFromState(
	state: AskState,
	questionnaire: AskQuestionnaire,
): readonly AskAnswer[] {
	return state.answers.flatMap((draft, index) =>
		draft.answered
			? [
					{
						id: questionnaire.questions[index]!.id,
						question: questionnaire.questions[index]!.question,
						selected: draft.selected.map((i) => ({
							index: i,
							label: questionnaire.questions[index]!.options[i]!.label,
						})),
						...(draft.custom === undefined ? {} : { custom: draft.custom }),
					},
				]
			: [],
	);
}
export function askDetails(questionnaire: AskQuestionnaire, state: AskState): AskToolDetails {
	const status = state.terminal ?? "submitted";
	return {
		questionnaire: normalizeAskParams(questionnaire),
		answers: answersFromState(state, questionnaire),
		status,
		cancelled: status === "cancelled",
	};
}
export function formatAskResult(details: AskToolDetails): string {
	if (details.status === "cancelled")
		return "User cancelled the questionnaire without submitting answers.";
	if (details.status === "aborted") return "Ask questionnaire was aborted before submission.";
	return [
		"User submitted answers:",
		...details.answers.map(
			(a) =>
				`- ${a.id}: ${[...a.selected.map((s) => s.label), ...(a.custom ? [`Other: ${a.custom}`] : []), ...(a.selected.length === 0 && !a.custom ? ["None selected"] : [])].join("; ")}`,
		),
	].join("\n");
}
