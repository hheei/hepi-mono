import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Terminal, Text, TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolResultLayout } from "@hheei/pi-ext-core";
import { ToolExecutionComponent } from "../../../node_modules/.bun/@earendil-works+pi-coding-agent@0.83.0+7eae918161e46c49/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../../node_modules/.bun/@earendil-works+pi-coding-agent@0.83.0+7eae918161e46c49/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { registerReadTool } from "../src/read.js";
import { SelectableReadResult } from "../src/selectable-read-result.js";

class InputTerminal implements Terminal {
	private input: ((data: string) => void) | undefined;
	readonly writes: string[] = [];

	get columns(): number {
		return 80;
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

test("dragging a read body uses Pi-owned result viewport bounds", async (): Promise<void> => {
	initTheme();
	const tools: ToolDefinition[] = [];
	const pi = {
		events: {},
		registerTool: (tool: ToolDefinition): void => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	registerReadTool(pi);
	const definition = tools[0];
	if (definition === undefined) throw new Error("Expected read definition");
	const selectionDefinition = {
		...definition,
		renderCall: (): Text => new Text("read value.txt", 0, 0),
	};

	const terminal = new InputTerminal();
	const tui = new TUI(terminal);
	const execution = new ToolExecutionComponent(
		"read",
		"read-1",
		{ path: "value.txt" },
		{},
		selectionDefinition,
		tui,
		process.cwd(),
	);
	tui.addChild(execution);
	execution.setArgsComplete();
	execution.updateResult({
		isError: false,
		content: [{ type: "text", text: "alpha" }],
		details: undefined,
	});
	execution.setExpanded(true);
	tui.start();
	await new Promise((resolve) => setTimeout(resolve, 25));

	const lines = tui.render(terminal.columns);
	const row = lines.findIndex((line) => line.includes("alpha"));
	if (row < 0) throw new Error("Expected read output row");
	const line = lines[row];
	const index = line?.indexOf("alpha") ?? -1;
	if (index < 0 || line === undefined) throw new Error("Expected read output column");
	const x = visibleWidth(line.slice(0, index));
	const result = (execution as unknown as { resultRendererComponent?: unknown })
		.resultRendererComponent;
	if (!(result instanceof SelectableReadResult)) throw new Error("Expected selectable read result");
	const before = result.render(terminal.columns);
	terminal.emit(`\x1b[<0;${x + 1};${row + 1}M`);
	await new Promise((resolve) => setTimeout(resolve, 25));
	terminal.emit(`\x1b[<32;${x + 2};${row + 1}M`);
	expect(result.render(terminal.columns)).not.toEqual(before);
	tui.stop();
});

test("selection follows result bounds after the viewport moves", (): void => {
	const terminal = new InputTerminal();
	const tui = new TUI(terminal);
	const firstBounds = { x: 2, y: 1, width: 20, height: 1 };
	const movedBounds = { x: 2, y: 7, width: 20, height: 1 };
	let publish: ((bounds: typeof firstBounds | undefined) => void) | undefined;
	const layout: ToolResultLayout = {
		tui,
		bounds: firstBounds,
		onChange(listener): () => void {
			publish = listener;
			listener(firstBounds);
			return (): void => {
				publish = undefined;
			};
		},
	};
	const result = new SelectableReadResult();

	tui.addChild(new Text("focus", 0, 0));
	tui.start();
	result.setResult("alpha", {} as never);
	result.bindLayout(layout);
	try {
		publish?.(movedBounds);
		terminal.emit(`\x1b[<0;${movedBounds.x + 1};${firstBounds.y + 1}M`);
		expect(result.hasSelection()).toBeFalse();

		terminal.emit(`\x1b[<0;${movedBounds.x + 1};${movedBounds.y + 1}M`);
		expect(result.hasSelection()).toBeTrue();
	} finally {
		result.dispose();
		tui.stop();
	}
});

test("collapsed read output leaves terminal mouse tracking disabled", async (): Promise<void> => {
	initTheme();
	const tools: ToolDefinition[] = [];
	const pi = {
		events: {},
		registerTool: (tool: ToolDefinition): void => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	registerReadTool(pi);
	const definition = tools[0];
	if (definition === undefined) throw new Error("Expected read definition");
	const terminal = new InputTerminal();
	const tui = new TUI(terminal);
	const execution = new ToolExecutionComponent(
		"read",
		"read-1",
		{ path: "value.txt" },
		{},
		definition,
		tui,
		process.cwd(),
	);
	tui.addChild(execution);
	execution.setArgsComplete();
	execution.updateResult({
		isError: false,
		content: [{ type: "text", text: "alpha" }],
		details: undefined,
	});
	tui.start();
	await new Promise((resolve) => setTimeout(resolve, 25));
	expect(terminal.writes).not.toContain("\x1b[?1002h\x1b[?1006h");
	tui.stop();
});
