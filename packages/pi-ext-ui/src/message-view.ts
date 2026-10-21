import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { MessageRows, MessageViewSpec } from "@hheei/pi-ext-core";
import { toContentRows, toSingleRow } from "./tool-view.js";

export type {
	MessageRows,
	MessageTone,
	MessageViewHeader,
	MessageViewSpec,
} from "@hheei/pi-ext-core";

/**
 * A transcript notice, not a tool execution.
 *
 * ToolView owns status, copy, rails, and the three-level fold. A message is a kind plus a
 * summary, optional preview lines, and a body that opens in one step. Expansion is remembered
 * on `stateHolder` by identity, so a host rebuild does not write a field into a session entry.
 */

const expansion = new WeakMap<object, boolean>();
const truncate = (text: string, width: number): string => truncateToWidth(text, width, "…");

function remembered(holder: object | undefined, fallback: boolean): boolean {
	if (holder === undefined) return fallback;
	return expansion.get(holder) ?? fallback;
}

function remember(holder: object | undefined, value: boolean): void {
	if (holder === undefined) return;
	expansion.set(holder, value);
}

function hasRows(source: MessageRows | undefined): boolean {
	if (source === undefined) return false;
	if (typeof source === "string") return source.trim() !== "";
	if (Array.isArray(source)) return source.some((line) => line.trim() !== "");
	return true;
}

function isComponent(source: MessageRows): source is Component {
	return typeof source !== "string" && !Array.isArray(source);
}

function layRows(source: MessageRows | undefined, width: number): readonly string[] {
	if (source === undefined || !hasRows(source)) return [];
	const inner = Math.max(1, width - 2);
	const raw = isComponent(source)
		? source.render(inner).flatMap((line) => toContentRows(line))
		: (typeof source === "string" ? [source] : source).flatMap((line) => toContentRows(line));
	const rows: string[] = [];
	for (const line of raw) {
		const wrapped = wrapTextWithAnsi(line, inner);
		for (const chunk of wrapped.length > 0 ? wrapped : [""]) {
			rows.push(truncate(`  ${chunk}`, width));
		}
	}
	return rows;
}

function invalidateRows(source: MessageRows | undefined): void {
	if (source !== undefined && isComponent(source)) source.invalidate();
}

export function createMessageView(spec: MessageViewSpec): MessageView {
	return new MessageView(spec);
}

export class MessageView implements Component {
	readonly #spec: MessageViewSpec;
	#localExpanded: boolean;
	#lastWidth = 80;
	#lastHeight = 0;
	#cache:
		| { readonly width: number; readonly expanded: boolean; readonly lines: string[] }
		| undefined;

	constructor(spec: MessageViewSpec) {
		this.#spec = spec;
		this.#localExpanded = remembered(spec.stateHolder, spec.defaultExpanded === true);
	}

	get expandable(): boolean {
		return hasRows(this.#spec.body);
	}

	/** What the user sees. Host ctrl+o wins over the remembered collapse. */
	get expanded(): boolean {
		return this.expandable && (this.#spec.forcedExpanded === true || this.#localExpanded);
	}

	toggle(): void {
		if (!this.expandable) return;
		const next = !this.expanded;
		this.#localExpanded = next;
		remember(this.#spec.stateHolder, next);
		this.#cache = undefined;
		this.#spec.invalidate?.();
	}

	render(width: number): string[] {
		const expanded = this.expanded;
		if (
			this.#cache !== undefined &&
			this.#cache.width === width &&
			this.#cache.expanded === expanded
		) {
			return this.#cache.lines;
		}
		const pad = Math.max(0, this.#spec.outputPad ?? 0);
		const safeWidth = Math.max(1, width - pad * 2);
		this.#lastWidth = width;
		const leftPad = pad > 0 ? " ".repeat(pad) : "";
		const lines = [
			this.#header(safeWidth, expanded),
			...layRows(this.#spec.preview, safeWidth),
			...(expanded ? layRows(this.#spec.body, safeWidth) : []),
		].map((line) => (leftPad === "" ? line : `${leftPad}${line}`));
		this.#lastHeight = lines.length;
		this.#cache = { width, expanded, lines };
		return lines;
	}

	invalidate(): void {
		this.#cache = undefined;
		invalidateRows(this.#spec.preview);
		invalidateRows(this.#spec.body);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (
			!this.expandable ||
			event.type === "wheel" ||
			event.type !== "click" ||
			event.button !== "left"
		) {
			return undefined;
		}
		const effectiveWidth = event.width > 0 ? event.width : this.#lastWidth;
		const pad = Math.max(0, this.#spec.outputPad ?? 0);
		const innerX = event.x - pad;
		const innerWidth = Math.max(1, effectiveWidth - pad * 2);
		if (innerX < 0 || innerX >= innerWidth) return undefined;
		if (this.#lastHeight > 0 && (event.y < 0 || event.y >= this.#lastHeight)) return undefined;
		if (event.y !== 0) return undefined;
		this.toggle();
		return { handled: true, render: true };
	}

	#header(width: number, expanded: boolean): string {
		const { theme, header } = this.#spec;
		const kind = theme.fg("dim", toSingleRow(header.kind));
		const summaryRaw = header.summary === undefined ? "" : toSingleRow(header.summary);
		const summary = summaryRaw === "" ? "" : theme.fg(header.tone ?? "dim", summaryRaw);
		const label = summary === "" ? kind : `${kind}${theme.fg("dim", " · ")}${summary}`;
		const pin = this.expandable ? `${theme.fg("dim", expanded ? "▾" : "▸")} ` : "";
		return truncate(`${pin}${label}`, width);
	}
}
