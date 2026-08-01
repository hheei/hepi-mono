import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import { type BtwTurn, extractAssistantText } from "./model.js";
import {
	formatKeymap,
	keyGlyph,
	padToWidth,
	renderScrollbar,
	truncateToWidth,
	wrap,
} from "./ui.js";

export type BtwComponentStatus =
	| { readonly kind: "pending" }
	| { readonly kind: "answer"; readonly text: string }
	| { readonly kind: "error"; readonly message: string };

/**
 * Feature-owned view state plus the minimal host callbacks needed for rendering.
 * The component never starts a model request and never owns the custom-surface lease.
 */
export interface BtwComponentOptions {
	readonly question: string;
	readonly history: readonly BtwTurn[];
	readonly theme: Theme;
	readonly host: { requestRender(): void; getTerminalRows(): number };
	readonly done: () => void;
	readonly onClearHistory: () => void;
}

export interface BtwComponentController extends Component {
	/** Updates are ignored after `close`; each accepted update requests a render. */
	setAnswer(text: string): void;
	setError(message: string): void;
	/** Signals the custom-surface host to close; safe to call more than once. */
	close(): void;
	/** Releases view-local state without changing feature history. */
	dispose(): void;
}

export function createBtwComponent(options: BtwComponentOptions): BtwComponentController {
	let status: BtwComponentStatus = { kind: "pending" };
	let history = [...options.history];
	let scrollTop: number | undefined;
	let closed = false;
	let lastMaxScroll = 0;
	let lastCapacity = 1;

	function requestRender(): void {
		options.host.requestRender();
	}

	function close(): void {
		if (closed) return;
		closed = true;
		options.done();
	}

	function statusLines(width: number): string[] {
		switch (status.kind) {
			case "pending":
				return [options.theme.fg("muted", "Waiting for the model...")];
			case "answer":
				return wrap(status.text, width);
			case "error":
				return wrap(options.theme.fg("error", `Error: ${status.message}`), width);
			default:
				return status satisfies never;
		}
	}

	function contentRows(width: number): string[] {
		const rows: string[] = [];
		for (const turn of history) {
			rows.push(options.theme.fg("accent", "Previous question"));
			rows.push(
				...wrap(
					typeof turn.user.content === "string"
						? turn.user.content
						: turn.user.content
								.map((part) => (part.type === "text" ? part.text : "[image omitted]"))
								.join("\n"),
					width,
				),
			);
			rows.push(...wrap(extractAssistantText(turn.assistant), width), "");
		}
		if (!options.question) {
			if (history.length === 0) rows.push(options.theme.fg("muted", "No BTW history yet."));
			return rows;
		}
		rows.push(options.theme.fg("accent", "Question"));
		rows.push(...wrap(options.question, width), "");
		rows.push(options.theme.fg("accent", status.kind === "answer" ? "Answer" : "Status"));
		rows.push(...statusLines(width));
		return rows;
	}

	function render(width: number): string[] {
		const safeWidth = Math.max(8, Math.floor(width));
		const contentWidth = Math.max(1, safeWidth - 4);
		const terminalRows = Math.max(8, Math.floor(options.host.getTerminalRows()));
		const heightRatio = terminalRows >= 40 ? 0.45 : terminalRows < 24 ? 0.6 : 0.5;
		const panelHeight = Math.max(8, Math.floor(terminalRows * heightRatio));
		const capacity = panelHeight - 3;
		let allRows = contentRows(contentWidth);
		const showScrollbar = allRows.length > capacity;
		if (showScrollbar) allRows = contentRows(Math.max(1, contentWidth - 2));
		const maxScroll = Math.max(0, allRows.length - capacity);
		const top = Math.min(scrollTop ?? maxScroll, maxScroll);
		lastCapacity = capacity;
		lastMaxScroll = maxScroll;
		const visible = allRows.slice(top, top + capacity);
		const scrollbar = renderScrollbar(allRows.length, capacity, top, visible.length, options.theme);
		const border = (text: string): string => options.theme.fg("border", text);
		const framedRow = (row: string, index: number): string => {
			const bar = scrollbar[index] ?? "";
			const rowWidth = showScrollbar ? contentWidth - 2 : contentWidth;
			const content = padToWidth(truncateToWidth(row, rowWidth, ""), rowWidth);
			const scrollColumn = showScrollbar ? ` ${bar}` : "";
			return `${border("│")} ${content}${scrollColumn} ${border("│")}`;
		};
		const body = Array.from({ length: capacity }, (_, index) =>
			framedRow(visible[index] ?? "", index),
		);
		const keymap = formatKeymap(
			[
				{ key: keyGlyph.vertical, label: "scroll", priority: 1 },
				{ key: "x", label: "clear history", priority: 0 },
				{ key: keyGlyph.cancel, label: "close", priority: 2 },
			],
			{ width: contentWidth },
		);
		const title = ` ${options.theme.fg("accent", options.theme.bold("BTW"))} `;
		const topRuleWidth = Math.max(0, safeWidth - 2 - 1 - 5);
		const topRule = `${border("╭─")}${title}${border(`${"─".repeat(topRuleWidth)}╮`)}`;
		const footer = `${border("│")} ${padToWidth(options.theme.fg("dim", keymap), contentWidth)} ${border("│")}`;
		const bottomRule = border(`╰${"─".repeat(safeWidth - 2)}╯`);
		return [topRule, ...body, footer, bottomRule];
	}

	function moveScroll(delta: number): void {
		const current = scrollTop ?? lastMaxScroll;
		scrollTop = Math.max(0, Math.min(lastMaxScroll, current + delta));
		requestRender();
	}

	function handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			close();
			return;
		}
		if (matchesKey(data, Key.up)) {
			moveScroll(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			moveScroll(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			moveScroll(-lastCapacity);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			moveScroll(lastCapacity);
			return;
		}
		if (data === "x") {
			history = [];
			options.onClearHistory();
			scrollTop = undefined;
			requestRender();
		}
	}

	return {
		render,
		handleInput,
		invalidate: requestRender,
		setAnswer(text: string): void {
			if (closed) return;
			status = { kind: "answer", text };
			scrollTop = undefined;
			requestRender();
		},
		setError(message: string): void {
			if (closed) return;
			status = { kind: "error", message };
			scrollTop = undefined;
			requestRender();
		},
		close,
		dispose: close,
	};
}
