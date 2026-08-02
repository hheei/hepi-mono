import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Terminal, Text, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../../../node_modules/.bun/@earendil-works+pi-coding-agent@0.83.0+7eae918161e46c49/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../../node_modules/.bun/@earendil-works+pi-coding-agent@0.83.0+7eae918161e46c49/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { SelectableBashResult } from "../src/selectable-bash-result.js";
import { registerTools } from "../src/tools.js";

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

test("dragging expanded truncated bash output preserves upstream warning rows", async (): Promise<void> => {
	initTheme();
	const tools: ToolDefinition[] = [];
	const pi = {
		events: {},
		registerTool: (tool: ToolDefinition): void => void tools.push(tool),
	} as unknown as ExtensionAPI;
	registerTools(pi);
	const definition = tools.find((tool) => tool.name === "bash");
	if (definition === undefined) throw new Error("Expected bash definition");
	const selectionDefinition = {
		...definition,
		renderCall: (): Text => new Text("$ printf alpha", 0, 0),
	};
	const terminal = new InputTerminal();
	const tui = new TUI(terminal);
	const execution = new ToolExecutionComponent(
		"bash",
		"bash-1",
		{ command: "printf alpha" },
		{},
		selectionDefinition,
		tui,
		process.cwd(),
	);
	tui.addChild(execution);
	execution.setArgsComplete();
	execution.updateResult({
		content: [
			{ type: "text", text: "alpha\n\n[Showing lines 1-1 of 2. Full output: /tmp/full-output]" },
		],
		details: {
			truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 2 },
			fullOutputPath: "/tmp/full-output",
		},
	});
	const collapsed = (execution as unknown as { resultRendererComponent?: unknown })
		.resultRendererComponent;
	expect(collapsed).not.toBeInstanceOf(SelectableBashResult);
	execution.setExpanded(true);
	tui.start();
	await new Promise((resolve) => setTimeout(resolve, 25));
	const lines = tui.render(terminal.columns);
	const row = lines.findLastIndex((line) => line.includes("alpha"));
	const line = lines[row];
	const index = line?.indexOf("alpha") ?? -1;
	if (row < 0 || line === undefined || index < 0) throw new Error("Expected bash output row");
	const result = (execution as unknown as { resultRendererComponent?: unknown })
		.resultRendererComponent;
	if (!(result instanceof SelectableBashResult)) throw new Error("Expected selectable bash result");
	const before = result.render(terminal.columns);
	const x = visibleWidth(line.slice(0, index));
	terminal.emit(`\x1b[<0;${x + 1};${row + 1}M`);
	terminal.emit(`\x1b[<32;${x + 2};${row + 1}M`);
	const selected = result.render(terminal.columns);
	expect(selected).not.toEqual(before);
	expect(selected.some((line) => line.includes("Full output: /tmp/full-output"))).toBe(true);
	execution.dispose();
	expect(terminal.writes).toContain("\x1b[?1002l\x1b[?1006l");
	tui.stop();
});
