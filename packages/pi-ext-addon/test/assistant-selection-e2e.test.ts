import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { type Terminal, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { createAssistantMessage } from "@hheei/pi-ext-core/testing";
import { createAssistantSelectionAddon } from "../src/assistant-selection.js";

const ansiBeforeStyled = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m(?=styled)`, "g");

class InputTerminal implements Terminal {
	private input: ((data: string) => void) | undefined;
	readonly writes: string[] = [];
	private readonly width: number;

	constructor(width: number) {
		this.width = width;
	}

	get columns(): number {
		return this.width;
	}
	get rows(): number {
		return 24;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.input = onInput;
	}
	stop(): void {}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	emit(data: string): void {
		this.input?.(data);
	}
}

function assistantMessage(kind: "text" | "thinking", value: string): AssistantMessage {
	return createAssistantMessage({
		content:
			kind === "text" ? [{ type: "text", text: value }] : [{ type: "thinking", thinking: value }],
	});
}

async function renderAssistant(
	kind: "text" | "thinking",
	padding: 0 | 1,
	width: number,
	value = `${kind} alpha beta gamma`,
	needle = `${kind} alpha`,
): Promise<{
	readonly terminal: InputTerminal;
	readonly tui: TUI;
	readonly component: AssistantMessageComponent;
	readonly line: string;
	readonly row: number;
	readonly x: number;
}> {
	initTheme();
	const terminal = new InputTerminal(width);
	const tui = new TUI(terminal);
	const component = new AssistantMessageComponent(
		assistantMessage(kind, value),
		false,
		undefined,
		undefined,
		padding,
		tui,
		createAssistantSelectionAddon(),
	);
	tui.addChild(component);
	tui.start();
	await new Promise((resolve) => setTimeout(resolve, 25));
	const lines = tui.render(terminal.columns);
	const row = lines.findIndex((candidate) => candidate.includes(needle));
	if (row < 0) throw new Error("Expected assistant block row");
	const line = lines[row];
	if (line === undefined) throw new Error("Expected assistant block line");
	const index = line.indexOf(needle);
	if (index < 0) throw new Error("Expected assistant block column");
	return { terminal, tui, component, line, row, x: visibleWidth(line.slice(0, index)) };
}

test("selection preserves rendered Markdown styles", async (): Promise<void> => {
	const rendered = await renderAssistant("text", 1, 80, "## **styled** output", "styled");
	const normal = rendered.tui.render(rendered.terminal.columns)[rendered.row] ?? "";
	const headingStyle = normal.match(ansiBeforeStyled)?.at(-1);
	if (headingStyle === undefined) throw new Error("Expected rendered heading style");
	rendered.terminal.emit(`\x1b[<0;${rendered.x + 1};${rendered.row + 1}M`);
	await new Promise((resolve) => setTimeout(resolve, 25));
	rendered.terminal.emit(`\x1b[<32;${rendered.x + 5};${rendered.row + 1}M`);
	await new Promise((resolve) => setTimeout(resolve, 25));
	expect(rendered.tui.render(rendered.terminal.columns)[rendered.row]).toContain(headingStyle);
	rendered.component.dispose();
	rendered.tui.stop();
});

test("streaming text replacement preserves captured selection", async (): Promise<void> => {
	const rendered = await renderAssistant("text", 1, 40);
	rendered.terminal.emit(`\x1b[<0;${rendered.x + 1};${rendered.row + 1}M`);
	await new Promise((resolve) => setTimeout(resolve, 25));
	rendered.component.updateContent(assistantMessage("text", "text alpha beta updated"));
	rendered.tui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
	const afterUpdate = rendered.tui.render(rendered.terminal.columns);
	rendered.terminal.emit(`\x1b[<32;${rendered.x + 5};${rendered.row + 1}M`);
	await new Promise((resolve) => setTimeout(resolve, 25));
	expect(rendered.tui.render(rendered.terminal.columns)).not.toEqual(afterUpdate);
	rendered.component.dispose();
	rendered.tui.stop();
});

for (const [kind, padding, width] of [
	["text", 1, 40],
	["thinking", 1, 40],
	["text", 0, 40],
	["text", 1, 80],
] as const) {
	test(`${kind} selection maps inner output padding ${padding} at ${width} columns`, async (): Promise<void> => {
		const rendered = await renderAssistant(kind, padding, width);
		const before = rendered.tui.render(rendered.terminal.columns);
		if (padding === 1) {
			rendered.terminal.emit(`\x1b[<0;${rendered.x};${rendered.row + 1}M`);
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(rendered.tui.render(rendered.terminal.columns)).toEqual(before);
		}
		rendered.terminal.emit(`\x1b[<0;${rendered.x + 1};${rendered.row + 1}M`);
		await new Promise((resolve) => setTimeout(resolve, 25));
		rendered.terminal.emit(`\x1b[<32;${rendered.x + 5};${rendered.row + 1}M`);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(rendered.tui.render(rendered.terminal.columns)).not.toEqual(before);
		rendered.component.dispose();
		rendered.tui.stop();
	});
}
