import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	MouseRegion,
	Spacer,
	Text,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { fitRow } from "@hheei/pi-ext-core";
import {
	formatToolHeaderText,
	isCollapsible,
	renderWithoutToolRails,
	type ToolStatusKind,
	type ToolViewChild,
} from "./tool-view.js";

export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export type MemberKind = "assistant" | "tool" | "notice";
export type Category = "tools" | "thinking" | "notices";

/** One transcript entry a block owns, reduced to the facts the collapsed frame draws. */
export interface Member {
	readonly kind: MemberKind;
	readonly component: Component;
	readonly title?: string;
	readonly summary?: string;
	readonly status?: ToolStatusKind;
	readonly children?: readonly ToolViewChild[];
	readonly thinking?: string;
	readonly thinkingChars?: number;
	readonly usage?: Usage;
	readonly detail?: (width: number) => string[];
}

/** One agent loop. Blocks created during the run share its origin; ending it freezes them. */
export interface ToolGroupRun {
	readonly startedAt: number;
	endedAt?: number;
}

interface Hit {
	readonly height: number;
	readonly action: Action;
}

type Action =
	| { readonly kind: "none" }
	| { readonly kind: "category"; readonly category: Category }
	| { readonly kind: "item"; readonly member: Component; readonly child?: number }
	| { readonly kind: "member"; readonly wrapper: Component };

function formatElapsed(milliseconds: number): string {
	const total = Math.max(0, Math.floor(milliseconds / 1000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	if (hours > 0)
		return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/** The same decimal steps the Pi footer uses, so two places never disagree about a token count. */
function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${String(Math.round(count / 1000))}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${String(Math.round(count / 1_000_000))}M`;
}

function cacheHitRate(latest: Usage | undefined, cacheTotal: number): string {
	if (latest === undefined || cacheTotal <= 0) return "—";
	const prompt = latest.input + latest.cacheRead + latest.cacheWrite;
	if (prompt <= 0) return "—";
	return `${((latest.cacheRead / prompt) * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

function preview(text: string): string | undefined {
	return text.split("\n").find((line) => line.trim() !== "");
}

/**
 * The collapsed frame of one activity block.
 *
 * The frame owns only layout and hit testing: tool rows keep their own component so their glyph,
 * colors, copy action, and fold level stay the ones the transcript already draws. Anything this
 * view synthesized itself would drift from those rows.
 */
export class ToolGroupView extends Container {
	readonly #header = new Text("", 0, 0);
	readonly #ui: ExtensionUIContext;
	readonly #redraw: () => void;
	readonly #run: ToolGroupRun | undefined;
	#members: Member[] = [];
	#settled = false;
	#raw = false;
	#category: Category | undefined;
	#item: { readonly member: Component; readonly child?: number } | undefined;
	#renderedExpanded = false;
	#hits: Hit[] = [];

	constructor(ui: ExtensionUIContext, redraw: () => void, run: ToolGroupRun | undefined) {
		super();
		this.#ui = ui;
		this.#redraw = redraw;
		this.#run = run;
		const heading = new MouseRegion(this.#header, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			this.#toggleRaw();
			return { handled: true, render: true };
		});
		const body: Component = {
			render: (width) => this.#renderBody(width),
			handleMouse: (event) => this.#hit(event),
			invalidate() {},
		};
		this.children = [new Spacer(1), heading, body];
	}

	#toggleRaw(): void {
		this.#raw = this.#ui.getToolsExpanded() ? false : !this.#raw;
		if (this.#raw) {
			this.#category = undefined;
			this.#item = undefined;
			for (const member of this.#members) {
				if (isCollapsible(member.component)) member.component.collapseAll();
			}
		}
		this.#redraw();
	}

	#tailIndex(): number {
		let tail = -1;
		for (const [index, member] of this.#members.entries()) {
			if (member.kind === "tool") tail = index;
		}
		return tail;
	}

	#historyTools(tailIndex: number): number[] {
		// The footer slot shows the tail only while the block runs; once it carries the request
		// totals the tail belongs to the list, or its call would disappear from the block.
		const tail = this.#settled ? -1 : tailIndex;
		const indices: number[] = [];
		for (const [index, member] of this.#members.entries()) {
			if (member.kind === "tool" && index !== tail) indices.push(index);
		}
		return indices;
	}

	#thinkingItems(): Member[] {
		return this.#members.filter((member) => (member.thinkingChars ?? 0) > 0);
	}

	#noticeItems(): Member[] {
		return this.#members.filter((member) => member.kind === "notice");
	}

	#calls(): number {
		let total = 0;
		for (const member of this.#members) {
			if (member.kind !== "tool") continue;
			total += member.children === undefined ? 1 : member.children.length;
		}
		return total;
	}

	#usage(): {
		readonly requests: number;
		readonly input: number;
		readonly output: number;
		readonly cacheTotal: number;
		readonly latest: Usage | undefined;
	} {
		let requests = 0;
		let input = 0;
		let output = 0;
		let cacheTotal = 0;
		let latest: Usage | undefined;
		for (const member of this.#members) {
			if (member.kind !== "assistant") continue;
			requests += 1;
			if (member.usage === undefined) continue;
			input += member.usage.input;
			output += member.usage.output;
			cacheTotal += member.usage.cacheRead + member.usage.cacheWrite;
			latest = member.usage;
		}
		return { requests, input, output, cacheTotal, latest };
	}

	/** The block footer: the whole block's request and token totals, fixed under the body. */
	#footerRow(): string {
		const theme = this.#ui.theme;
		const usage = this.#usage();
		const input = usage.latest === undefined ? "—" : formatTokens(usage.input);
		const output = usage.latest === undefined ? "—" : formatTokens(usage.output);
		const parts = [
			`Requests ×${usage.requests}`,
			`IN ${input}`,
			`OUT ${output}`,
			`CH ${cacheHitRate(usage.latest, usage.cacheTotal)}`,
		];
		return theme.fg("dim", parts.join(" · "));
	}

	#categoryRow(category: Category, label: string, detail: string): string {
		const theme = this.#ui.theme;
		const pin = `${theme.fg("dim", this.#category === category ? "▾" : "▸")} `;
		const tail = detail === "" ? "" : `${theme.fg("dim", " · ")}${theme.fg("dim", detail)}`;
		return `${pin}${theme.fg("muted", label)}${tail}`;
	}

	#renderBody(width: number): string[] {
		if (this.#renderedExpanded) return this.#renderRaw(width);
		return this.#renderFrame(width);
	}

	#renderRaw(width: number): string[] {
		const theme = this.#ui.theme;
		const rail = theme.fg("muted", "─".repeat(Math.max(0, width)));
		const lines: string[] = [rail];
		const hits: Hit[] = [{ height: 1, action: { kind: "none" } }];
		for (const member of this.#members) {
			const wrapper = this.#offsetWrapper(member.component);
			const rows = renderWithoutToolRails(wrapper, Math.max(1, width));
			if (rows.length === 0) continue;
			hits.push({ height: rows.length, action: { kind: "member", wrapper } });
			for (const row of rows) lines.push(fitRow(row, Math.max(0, width), "…"));
		}
		lines.push(rail);
		hits.push({ height: 1, action: { kind: "none" } });
		this.#hits = hits;
		return lines;
	}

	/** Header, rails, the three categories, and the read-only tail; every row is one terminal row. */
	#renderFrame(width: number): string[] {
		const theme = this.#ui.theme;
		const lines: string[] = [];
		const hits: Hit[] = [];
		const push = (row: string, action: Action = { kind: "none" }) => {
			lines.push(fitRow(row, Math.max(0, width), "…"));
			hits.push({ height: 1, action });
		};
		/** Rows that belong to one component keep one hit so its own geometry stays correct. */
		const pushBlock = (rows: readonly string[], action: Action) => {
			if (rows.length === 0) return;
			for (const row of rows) lines.push(fitRow(row, Math.max(0, width), "…"));
			hits.push({ height: rows.length, action });
		};
		const rail = theme.fg("muted", "─".repeat(Math.max(0, width)));
		const tailIndex = this.#tailIndex();
		const tools = this.#historyTools(tailIndex);
		push(rail);

		const notices = this.#noticeItems();
		if (notices.length > 0) {
			const kinds = new Map<string, number>();
			for (const member of notices) {
				const kind = member.title ?? "notice";
				kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
			}
			const detail = [...kinds].map(([kind, count]) => `${kind} ×${count}`).join(" · ");
			push(this.#categoryRow("notices", "notice", detail), {
				kind: "category",
				category: "notices",
			});
			if (this.#category === "notices") this.#renderNotices(notices, width, push);
		}

		const thinking = this.#thinkingItems();
		if (thinking.length > 0) {
			const tokens = Math.ceil(
				thinking.reduce((sum, member) => sum + (member.thinkingChars ?? 0), 0) / 4,
			);
			push(this.#categoryRow("thinking", "thinking", `${String(tokens)} tokens`), {
				kind: "category",
				category: "thinking",
			});
			if (this.#category === "thinking") this.#renderThinking(thinking, width, push);
		}

		const counts = new Map<string, number>();
		for (const index of tools) {
			const member = this.#members[index];
			if (member === undefined) continue;
			if (member.children === undefined) {
				if (member.title !== undefined)
					counts.set(member.title, (counts.get(member.title) ?? 0) + 1);
				continue;
			}
			for (const child of member.children)
				counts.set(child.title, (counts.get(child.title) ?? 0) + 1);
		}
		if (counts.size > 0) {
			const names = [...counts]
				.map(
					([name, count]) =>
						`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", `×${count}`)}`,
				)
				.join(theme.fg("dim", " · "));
			push(this.#categoryRow("tools", names, ""), {
				kind: "category",
				category: "tools",
			});
			if (this.#category === "tools") this.#renderTools(theme, tools, width, push, pushBlock);
		}

		push(rail);

		// One footer slot: the running tail while the block is live, the block totals once it settles.
		const tail = this.#members[tailIndex];
		if (this.#settled) push(this.#footerRow());
		else if (tail !== undefined && tail.title !== undefined) {
			push(formatToolHeaderText({ status: tail.status, title: tail.title }, theme));
		}
		this.#hits = hits;
		return lines;
	}

	/** Every tool at its own level 0, one blank row between calls. */
	#renderTools(
		theme: ExtensionUIContext["theme"],
		tools: readonly number[],
		width: number,
		push: (row: string, action?: Action) => void,
		pushBlock: (rows: readonly string[], action: Action) => void,
	): void {
		let first = true;
		const separate = () => {
			if (!first) push("");
			first = false;
		};
		for (const memberIndex of tools) {
			const member = this.#members[memberIndex];
			if (member === undefined) continue;
			if (member.children === undefined) {
				const wrapper = this.#offsetWrapper(member.component);
				separate();
				// One hit for the whole tool: its own rows carry the header, copy slot, and fold state.
				pushBlock(renderWithoutToolRails(wrapper, Math.max(1, width)), {
					kind: "member",
					wrapper,
				});
				continue;
			}
			for (const [index, child] of member.children.entries()) {
				separate();
				const open = this.#item?.member === member.component && this.#item.child === index;
				push(
					`${theme.fg("dim", open ? "▾" : "▸")} ${formatToolHeaderText({ status: child.status, title: child.title, summary: child.summary }, theme)}`,
					{ kind: "item", member: member.component, child: index },
				);
				if (!open || child.detail === undefined) continue;
				for (const row of this.#detailRows(child.detail, width)) push(row);
			}
		}
	}

	/** One thinking block per assistant turn: a label row, one preview row, and the text on demand. */
	#renderThinking(
		thinking: readonly Member[],
		width: number,
		push: (row: string, action?: Action) => void,
	): void {
		const theme = this.#ui.theme;
		let first = true;
		for (const member of thinking) {
			if (!first) push("");
			first = false;
			const open = this.#item?.member === member.component;
			const tokens = Math.ceil((member.thinkingChars ?? 0) / 4);
			push(
				`${theme.fg("dim", open ? "▾" : "▸")} ${theme.fg("muted", "thinking")}${theme.fg("dim", ` · ${String(tokens)} tokens`)}`,
				{ kind: "item", member: member.component },
			);
			const text = member.thinking;
			if (text === undefined) continue;
			if (open) {
				for (const row of this.#detailRows(text, width)) push(row);
				continue;
			}
			const line = preview(text);
			if (line !== undefined) push(`${theme.fg("dim", "▎")} ${theme.fg("thinkingText", line)}`);
		}
	}

	/** Notices keep one row each and open their provider-rendered detail in place. */
	#renderNotices(
		notices: readonly Member[],
		width: number,
		push: (row: string, action?: Action) => void,
	): void {
		const theme = this.#ui.theme;
		for (const member of notices) {
			const detail = member.detail;
			const open = detail !== undefined && this.#item?.member === member.component;
			const pin = detail === undefined ? "" : `${theme.fg("dim", open ? "▾" : "▸")} `;
			push(
				`${pin}${member.summary ?? member.title ?? ""}`,
				detail === undefined ? { kind: "none" } : { kind: "item", member: member.component },
			);
			if (!open) continue;
			for (const row of detail(width)) push(row);
		}
	}

	#hit(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
		let y = event.y;
		for (const hit of this.#hits) {
			if (y >= hit.height) {
				y -= hit.height;
				continue;
			}
			const action = hit.action;
			if (action.kind === "none") return undefined;
			if (event.type !== "click" || event.button !== "left") return undefined;
			if (action.kind === "category") {
				const open = this.#category === action.category;
				this.#category = open ? undefined : action.category;
				this.#item = undefined;
				this.#redraw();
				return { handled: true, render: true };
			}
			if (action.kind === "item") {
				const same = this.#item?.member === action.member && this.#item.child === action.child;
				this.#item = same
					? undefined
					: {
							member: action.member,
							...(action.child === undefined ? {} : { child: action.child }),
						};
				this.#redraw();
				return { handled: true, render: true };
			}
			return action.wrapper.handleMouse?.({ ...event, y, height: hit.height });
		}
		return undefined;
	}

	/**
	 * The member's own rows without Pi's leading separator. Built only for a member the current frame
	 * actually draws, so a collapsed category allocates nothing for the rows it hides.
	 */
	#offsetWrapper(component: Component): Component {
		let offset = 0;
		return {
			render(width) {
				const rows = component.render(width);
				// Pi adds one leading separator per tool; the group supplies its own spacing.
				offset = rows[0] === "" ? 1 : 0;
				return rows.slice(offset);
			},
			handleMouse(event) {
				return component.handleMouse?.({
					...event,
					y: event.y + offset,
					height: event.height + offset,
				});
			},
			invalidate() {},
		};
	}

	/**
	 * Expanded detail keeps its text. The user opened it to read it, so a line wider than the frame is
	 * wrapped to the width the indent leaves instead of being cut with an ellipsis.
	 */
	#detailRows(text: string, width: number): string[] {
		const inner = Math.max(1, width - 2);
		return text.split("\n").flatMap((line) => {
			const wrapped = wrapTextWithAnsi(line, inner);
			return (wrapped.length > 0 ? wrapped : [""]).map((row) => `  ${row}`);
		});
	}

	update(members: Member[], settled: boolean): void {
		this.#members = members;
		this.#settled = settled;
		if (this.#item !== undefined && !members.some((m) => m.component === this.#item?.member))
			this.#item = undefined;
		if (this.#category === "thinking" && this.#thinkingItems().length === 0)
			this.#category = undefined;
		if (this.#category === "notices" && this.#noticeItems().length === 0)
			this.#category = undefined;
	}

	override invalidate(): void {
		// Original chatContainer.invalidate invalidates original members exactly once; only the header
		// text belongs to this view.
		this.#header.invalidate();
	}

	override render(width: number): string[] {
		const globalExpanded = this.#ui.getToolsExpanded();
		if (globalExpanded) {
			// The host's forced expansion owns the frame; closing it returns to a fully closed group.
			this.#category = undefined;
			this.#item = undefined;
		}
		this.#renderedExpanded = this.#raw || globalExpanded;
		const theme = this.#ui.theme;
		const calls = this.#calls();
		const elapsed =
			this.#run === undefined
				? "—"
				: formatElapsed((this.#run.endedAt ?? performance.now()) - this.#run.startedAt);
		const details = [
			theme.fg("muted", "collapse views"),
			theme.fg("dim", elapsed),
			theme.fg("dim", `${calls} ${calls === 1 ? "call" : "calls"}`),
		].join(theme.fg("dim", " · "));
		this.#header.setText(
			fitRow(
				`${theme.fg("dim", this.#renderedExpanded ? "▾" : "▸")} ${details}`,
				Math.max(0, width),
				"…",
			),
		);
		return super.render(width);
	}
}
