import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Key, matchesKey } from "@earendil-works/pi-tui";
import {
	formatKeymap,
	keyGlyph,
	padToWidth,
	renderScrollbar,
	renderSelectableRow,
	renderTabs,
	truncateToWidth,
	wrap,
} from "../../../hepi-basics/src/core/index.js";
import {
	ASK_LIMITS,
	ASK_OTHER_LABEL,
	type AskAnswerDraft,
	type AskInteractionResult,
	type AskQuestion,
	type AskQuestionnaire,
	type AskState,
	askDetails,
	freshAskState,
	normalizeAskParams,
	reduceAsk,
	validateAskCustomAnswer,
} from "./model.js";

export interface AskComponentOptions {
	readonly questionnaire: AskQuestionnaire;
	readonly host: { requestRender(): void; getTerminalRows(): number };
	readonly theme: Theme;
	readonly signal?: AbortSignal;
	readonly done: (result: AskInteractionResult) => void;
}

type Block = readonly string[];

function invariant<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new Error(message);
	return value;
}

export function formatAskReviewAnswer(question: AskQuestion, draft: AskAnswerDraft): string {
	return (
		[
			...draft.selected.map(
				(selected) =>
					invariant(question.options[selected], "Ask option state is inconsistent").label,
			),
			...(draft.custom ? [`Other: ${draft.custom}`] : []),
		].join(", ") || "None selected"
	);
}

/** Pick complete blocks around focus, clipping only when one block exceeds budget. */
export function visibleBlocks(
	blocks: readonly Block[],
	focusedIndex: number,
	rowBudget: number,
): { rows: string[]; clippedAbove: boolean; clippedBelow: boolean } {
	const budget = Math.max(0, Math.floor(rowBudget));
	if (!blocks.length || budget === 0)
		return { rows: [], clippedAbove: blocks.length > 0, clippedBelow: false };
	const focus = Math.max(0, Math.min(blocks.length - 1, focusedIndex));
	const rows: string[] = [];
	let first = focus;
	let last = focus;
	let used = invariant(blocks[focus], "Ask viewport focus is inconsistent").length;
	while (first > 0 || last < blocks.length - 1) {
		const before =
			first > 0
				? invariant(blocks[first - 1], "Ask viewport block is inconsistent").length
				: Infinity;
		const after =
			last < blocks.length - 1
				? invariant(blocks[last + 1], "Ask viewport block is inconsistent").length
				: Infinity;
		if (after <= before && last < blocks.length - 1 && used + after <= budget) {
			last++;
			used += after;
			continue;
		}
		if (first > 0 && used + before <= budget) {
			first--;
			used += before;
			continue;
		}
		if (last < blocks.length - 1 && used + after <= budget) {
			last++;
			used += after;
			continue;
		}
		break;
	}
	for (let i = first; i <= last; i++)
		rows.push(...invariant(blocks[i], "Ask viewport block is inconsistent"));
	const clippedAbove = first > 0;
	const clippedBelow = last < blocks.length - 1;
	if (rows.length <= budget) return { rows, clippedAbove, clippedBelow };
	const clipped = rows.slice(0, budget);
	return { rows: clipped, clippedAbove, clippedBelow: true };
}

function printableInput(input: string): boolean {
	return (
		input.length > 0 &&
		!input.startsWith("\x1b") &&
		!/\p{Cc}/u.test(input) &&
		!/[\u2028\u2029]/u.test(input)
	);
}

class BoundedInput {
	private readonly input = new Input();
	private readonly maxLength: number;
	private pasteBuffer = "";
	private collectingPaste: boolean = false;
	constructor(maxLength: number) {
		this.maxLength = maxLength;
		this.input.focused = true;
	}
	getValue(): string {
		return this.input.getValue();
	}
	setValue(value: string): void {
		this.input.setValue(this.safe(value));
	}
	private safe(value: string): string {
		let result = "";
		for (const char of value) {
			if (/\p{Cc}/u.test(char) || /[\u2028\u2029]/u.test(char)) continue;
			if ([...result, char].length > this.maxLength) break;
			result += char;
		}
		return result;
	}
	private handlePaste(data: string): boolean {
		const start = "\x1b[200~";
		const end = "\x1b[201~";
		if (!this.collectingPaste && !data.startsWith(start)) return false;
		let chunk = data;
		if (!this.collectingPaste) {
			this.collectingPaste = true;
			this.pasteBuffer = "";
			chunk = chunk.slice(start.length);
		}
		const endAt = chunk.indexOf(end);
		const payload = endAt < 0 ? chunk : chunk.slice(0, endAt);
		this.pasteBuffer = this.safe(this.pasteBuffer + payload);
		if (endAt < 0) return true;
		this.collectingPaste = false;
		this.input.handleInput(`${start}${this.pasteBuffer}${end}`);
		this.pasteBuffer = "";
		return true;
	}
	handleInput(data: string): void {
		if (this.handlePaste(data)) return;
		if (printableInput(data)) {
			const remaining = this.maxLength - [...this.getValue()].length;
			if (remaining <= 0) return;
			this.input.handleInput([...data].slice(0, remaining).join(""));
		} else this.input.handleInput(data);
		const after = this.safe(this.getValue());
		if (after !== this.getValue()) this.input.setValue(after);
	}
	render(width: number): string[] {
		return this.input.render(Math.max(0, width));
	}
	invalidate(): void {
		this.input.invalidate();
	}
}

function finishLine(text: string, width: number): string {
	return padToWidth(truncateToWidth(text, width, ""), width);
}

export function createAskComponent(options: AskComponentOptions): Component & { dispose(): void } {
	const questionnaire = normalizeAskParams(options.questionnaire);
	let state: AskState = freshAskState(questionnaire);
	let width = 80;
	let reviewScrollTop = 0;
	let reviewMaxScroll = 0;
	let editor: BoundedInput | undefined;
	let settled = false;
	let abortCleanup: (() => void) | undefined;

	function settle(result: AskInteractionResult): void {
		if (settled) return;
		settled = true;
		abortCleanup?.();
		abortCleanup = undefined;
		options.done(result);
	}
	function checkTerminal(): void {
		if (state.terminal)
			settle({ status: state.terminal, details: askDetails(questionnaire, state) });
	}
	function apply(action: Parameters<typeof reduceAsk>[2]): void {
		if (settled) return;
		const previous = state;
		state = reduceAsk(state, questionnaire, action);
		if (state !== previous) {
			if (state.mode !== "custom") editor = undefined;
			options.host.requestRender();
		}
		checkTerminal();
	}
	function openCustom(): void {
		if (settled) return;
		state = reduceAsk(state, questionnaire, { type: "open_custom" });
		editor = new BoundedInput(ASK_LIMITS.maxCustomAnswerLength);
		editor.setValue(state.customDraft);
		options.host.requestRender();
	}
	function renderFooter(): string {
		const hints =
			state.mode === "review"
				? [
						{ key: keyGlyph.vertical, label: "scroll", priority: 2 },
						{ key: keyGlyph.horizontal, label: "switch", priority: 1 },
						{ key: keyGlyph.confirm, label: "submit", priority: 3 },
						{ key: keyGlyph.cancel, label: "cancel", priority: 3 },
					]
				: state.mode === "custom"
					? [
							{ key: keyGlyph.confirm, label: "save", priority: 3 },
							{ key: keyGlyph.cancel, label: "cancel", priority: 3 },
						]
					: [
							{ key: keyGlyph.vertical, label: "navigate", priority: 2 },
							{ key: keyGlyph.horizontal, label: "switch", priority: 1 },
							{ key: keyGlyph.confirm, label: "select", priority: 3 },
							{ key: keyGlyph.cancel, label: "skip", priority: 3 },
						];
		return formatKeymap(hints, { width, separator: " · " });
	}
	function renderQuestionBody(bodyWidth: number): Block[] {
		const q = invariant(
			questionnaire.questions[state.questionIndex],
			"Ask question state is inconsistent",
		);
		const blocks: Block[] = [];
		if (questionnaire.context)
			blocks.push(
				wrap(`Context: ${questionnaire.context}`, bodyWidth).map((line) =>
					options.theme.fg("muted", line),
				),
			);
		blocks.push(wrap(`Q: ${q.question}`, bodyWidth).map((line) => options.theme.bold(line)));
		q.options.forEach((option, index) => {
			const selected = state.answers[state.questionIndex]?.selected.includes(index);
			const focused = state.focusedOption[state.questionIndex] === index;
			const label = renderSelectableRow({
				width: bodyWidth,
				selected: focused,
				label: `${option.label}${q.recommended === index ? " (Recommended)" : ""}`,
			});
			const color = selected ? "accent" : focused ? "warning" : undefined;
			const style = (line: string): string => (color ? options.theme.fg(color, line) : line);
			const rows = [style(finishLine(label, bodyWidth))];
			if (option.description)
				rows.push(
					...wrap(option.description, Math.max(1, bodyWidth - 2)).map((line) => style(`  ${line}`)),
				);
			blocks.push(rows);
		});
		const otherFocused = state.focusedOption[state.questionIndex] === q.options.length;
		const other = renderSelectableRow({
			width: bodyWidth,
			selected: otherFocused,
			label: ASK_OTHER_LABEL,
		});
		blocks.push([otherFocused ? options.theme.fg("warning", other) : other]);
		if (state.mode === "custom") {
			const customEditor = invariant(editor, "Ask custom editor state is inconsistent");
			const inputRows = customEditor.render(Math.max(1, bodyWidth - 2));
			blocks.push([
				options.theme.fg("muted", "Your answer:"),
				...inputRows.map((line) => `  ${line}`),
			]);
		}
		return blocks;
	}
	function wrapReviewAnswer(answer: string, answered: boolean, bodyWidth: number): string[] {
		const glyph = options.theme.fg("borderAccent", answered ? "☑" : "☐");
		return wrap(answer, Math.max(1, bodyWidth - 2)).map(
			(line, index) => `${index === 0 ? `${glyph} ` : "  "}${options.theme.fg("border", line)}`,
		);
	}
	function renderReviewRows(bodyWidth: number): string[] {
		return questionnaire.questions.flatMap((q, index) => {
			const draft = invariant(state.answers[index], "Ask answer state is inconsistent");
			const answer = formatAskReviewAnswer(q, draft);
			return [
				...wrap(`#${index + 1} ${q.question}`, bodyWidth).map((line) =>
					options.theme.fg("dim", line),
				),
				...wrapReviewAnswer(answer, draft.answered, bodyWidth),
			];
		});
	}
	function renderReviewViewport(bodyWidth: number, capacity: number): string[] {
		let contentWidth = bodyWidth;
		let rows = renderReviewRows(contentWidth);
		const showScrollbar = rows.length > capacity && bodyWidth >= 4;
		if (showScrollbar) {
			contentWidth = bodyWidth - 3;
			rows = renderReviewRows(contentWidth);
		}
		reviewMaxScroll = Math.max(0, rows.length - capacity);
		reviewScrollTop = Math.min(reviewScrollTop, reviewMaxScroll);
		const visible = rows.slice(reviewScrollTop, reviewScrollTop + capacity);
		if (!showScrollbar) return visible;
		const scrollbar = renderScrollbar(
			rows.length,
			capacity,
			reviewScrollTop,
			visible.length,
			options.theme,
		);
		return visible.map(
			(line, index) => `${padToWidth(line, contentWidth)}  ${scrollbar[index] ?? ""}`,
		);
	}
	function scrollReview(delta: -1 | 1): void {
		const next = Math.max(0, Math.min(reviewMaxScroll, reviewScrollTop + delta));
		if (next === reviewScrollTop) return;
		reviewScrollTop = next;
		options.host.requestRender();
	}
	function render(nextWidth: number): string[] {
		width = Math.max(0, Math.floor(nextWidth));
		const labels = questionnaire.questions
			.map((_, index) => `${state.answers[index]?.answered ? "☑" : "☐"} #${index + 1}`)
			.concat("≡ Review");
		const tabs = renderTabs(
			labels,
			state.mode === "review" ? questionnaire.questions.length : state.questionIndex,
			width,
			options.theme,
		);
		const title =
			state.mode === "review" ? "? Ask · Review" : `? Ask · Question #${state.questionIndex + 1}`;
		const header = [
			options.theme.fg("accent", options.theme.bold(truncateToWidth(title, width, ""))),
			"",
		];
		const bodyWidth = Math.max(1, width);
		const terminalRows = Math.max(1, Math.floor(options.host.getTerminalRows()));
		const fixed = tabs.length + header.length + 2 + 1;
		let body: string[];
		if (state.mode === "review") {
			body = renderReviewViewport(bodyWidth, Math.max(0, terminalRows - fixed));
		} else {
			const blocks = renderQuestionBody(bodyWidth);
			const focusBlock =
				(questionnaire.context ? 1 : 0) +
				1 +
				invariant(state.focusedOption[state.questionIndex], "Ask focus state is inconsistent");
			const viewport = visibleBlocks(blocks, focusBlock, Math.max(0, terminalRows - fixed - 2));
			body = [
				...(viewport.clippedAbove ? ["↑"] : []),
				...viewport.rows,
				...(viewport.clippedBelow ? ["↓"] : []),
			];
		}
		const footer = finishLine(options.theme.fg("dim", renderFooter()), width);
		const separator = finishLine(options.theme.fg("text", "─".repeat(Math.max(0, width))), width);
		return [...tabs, ...header, ...body, "", footer, separator].map((line) =>
			finishLine(line, width),
		);
	}
	function handleInput(input: string): void {
		if (settled) return;
		if (options.signal?.aborted) {
			apply({ type: "abort" });
			return;
		}
		if (state.mode === "custom") {
			const customEditor = invariant(editor, "Ask custom editor state is inconsistent");
			if (matchesKey(input, Key.enter)) {
				const value = customEditor.getValue();
				try {
					validateAskCustomAnswer(value);
				} catch {
					options.host.requestRender();
					return;
				}
				state = reduceAsk(state, questionnaire, { type: "set_custom_draft", value });
				apply({ type: "commit_custom" });
				return;
			}
			if (matchesKey(input, Key.escape)) {
				apply({ type: "cancel_custom" });
				return;
			}
			customEditor.handleInput(input);
			state = reduceAsk(state, questionnaire, {
				type: "set_custom_draft",
				value: customEditor.getValue(),
			});
			options.host.requestRender();
			return;
		}
		if (matchesKey(input, Key.left)) {
			apply({ type: "move_tab", delta: -1 });
			return;
		}
		if (matchesKey(input, Key.right)) {
			apply({ type: "move_tab", delta: 1 });
			return;
		}
		if (matchesKey(input, Key.escape)) {
			apply({ type: "cancel" });
			return;
		}
		if (state.mode === "review") {
			if (matchesKey(input, Key.up)) scrollReview(-1);
			else if (matchesKey(input, Key.down)) scrollReview(1);
			else if (matchesKey(input, Key.enter)) apply({ type: "submit" });
			return;
		}
		if (matchesKey(input, Key.up)) {
			apply({ type: "move_option", delta: -1 });
			return;
		}
		if (matchesKey(input, Key.down)) {
			apply({ type: "move_option", delta: 1 });
			return;
		}
		if (matchesKey(input, Key.enter)) {
			const q = invariant(
				questionnaire.questions[state.questionIndex],
				"Ask question state is inconsistent",
			);
			if (state.focusedOption[state.questionIndex] === q.options.length) openCustom();
			else apply({ type: "select_option" });
		}
	}
	if (options.signal) {
		const onAbort = () => apply({ type: "abort" });
		if (options.signal.aborted) onAbort();
		else {
			options.signal.addEventListener("abort", onAbort, { once: true });
			abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
		}
	}
	return {
		render,
		handleInput,
		invalidate: () => options.host.requestRender(),
		dispose: () => {
			if (!settled) apply({ type: "abort" });
			else abortCleanup?.();
		},
	};
}
