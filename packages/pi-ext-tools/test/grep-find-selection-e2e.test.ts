import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Terminal, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../../../node_modules/.bun/@earendil-works+pi-coding-agent@0.83.0+7eae918161e46c49/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../../node_modules/.bun/@earendil-works+pi-coding-agent@0.83.0+7eae918161e46c49/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
	SelectableToolTextResult,
	selectableToolText,
} from "../src/selectable-tool-text-result.js";
import { registerTools } from "../src/tools.js";

class InputTerminal implements Terminal {
	private input: ((data: string) => void) | undefined;
	readonly writes: string[] = [];
	private readonly columnCount: number;

	constructor(columns = 80) {
		this.columnCount = columns;
	}

	get columns(): number {
		return this.columnCount;
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

function registeredTool(name: string): ToolDefinition {
	const tools: ToolDefinition[] = [];
	const pi = {
		events: {},
		registerTool: (tool: ToolDefinition): void => void tools.push(tool),
	} as unknown as ExtensionAPI;
	registerTools(pi);
	const definition = tools.find((tool) => tool.name === name);
	if (definition === undefined) throw new Error(`Missing ${name} definition`);
	return definition;
}

function resultRendererComponent(execution: ToolExecutionComponent): unknown {
	const value: unknown = execution;
	if (value === null || typeof value !== "object" || !("resultRendererComponent" in value)) {
		return undefined;
	}
	return value.resultRendererComponent;
}

async function renderToolResult(args: {
	readonly toolName: "grep" | "find";
	readonly toolCallId: string;
	readonly toolArgs: Record<string, unknown>;
	readonly text: string;
	readonly columns?: number;
}): Promise<{
	readonly terminal: InputTerminal;
	readonly tui: TUI;
	readonly result: SelectableToolTextResult;
	readonly lines: readonly string[];
}> {
	initTheme();
	const terminal = new InputTerminal(args.columns);
	const tui = new TUI(terminal);
	const execution = new ToolExecutionComponent(
		args.toolName,
		args.toolCallId,
		args.toolArgs,
		{},
		registeredTool(args.toolName),
		tui,
		process.cwd(),
	);
	tui.addChild(execution);
	execution.setArgsComplete();
	execution.updateResult({ content: [{ type: "text", text: args.text }], details: undefined });
	tui.start();
	await new Promise((resolve) => setTimeout(resolve, 25));
	const result = resultRendererComponent(execution);
	if (!(result instanceof SelectableToolTextResult)) {
		throw new Error(`Expected selectable ${args.toolName} result`);
	}
	return { terminal, tui, result, lines: tui.render(terminal.columns) };
}

test("grep selection skips shell padding and renderer blank row", async (): Promise<void> => {
	const { terminal, tui, result, lines } = await renderToolResult({
		toolName: "grep",
		toolCallId: "grep-1",
		toolArgs: { pattern: "ctx_search", path: "packages/pi-mctx/src" },
		text: "4/4 matches in 1 files:\npackages/pi-mctx/src/value.ts:1: ctx_search result",
	});
	const row = lines.findIndex((line) => line.includes("4/4 matches"));
	const line = lines[row];
	const index = line?.indexOf("4/4 matches") ?? -1;
	if (row < 0 || line === undefined || index < 0) throw new Error("Expected grep count row");
	const before = result.render(terminal.columns);
	const x = visibleWidth(line.slice(0, index));
	terminal.emit(`\x1b[<0;${x + 1};${row + 1}M`);
	terminal.emit(`\x1b[<32;${x + 2};${row + 1}M`);
	expect(result.render(terminal.columns)).not.toEqual(before);
	tui.stop();
});

test("find selection covers visible result paths", async (): Promise<void> => {
	const { terminal, tui, result, lines } = await renderToolResult({
		toolName: "find",
		toolCallId: "find-1",
		toolArgs: { pattern: "*.ts" },
		text: "src/alpha.ts\nsrc/beta.ts",
	});
	const row = lines.findIndex((line) => line.includes("src/alpha.ts"));
	const line = lines[row];
	const index = line?.indexOf("src/alpha.ts") ?? -1;
	if (row < 0 || line === undefined || index < 0) throw new Error("Expected find result row");
	const before = result.render(terminal.columns);
	const x = visibleWidth(line.slice(0, index));
	terminal.emit(`\x1b[<0;${x + 1};${row + 1}M`);
	terminal.emit(`\x1b[<32;${x + 2};${row + 1}M`);
	expect(result.render(terminal.columns)).not.toEqual(before);
	tui.stop();
});

test("narrow grep selection follows visual wrapping without logical newlines", async (): Promise<void> => {
	const text = "alpha beta gamma longword";
	const { terminal, tui, result, lines } = await renderToolResult({
		toolName: "grep",
		toolCallId: "grep-narrow",
		toolArgs: { pattern: "alpha" },
		text,
		columns: 24,
	});
	expect(selectableToolText({ content: [{ type: "text", text }] }, { expanded: true }, 15)).toBe(
		text,
	);
	const firstRow = lines.findIndex((line) => line.includes("alpha beta gamma"));
	const secondRow = lines.findIndex((line) => line.includes("longword"));
	const first = lines[firstRow];
	const second = lines[secondRow];
	if (firstRow < 0 || secondRow < 0 || first === undefined || second === undefined) {
		throw new Error("Expected wrapped grep result rows");
	}
	const before = result.render(terminal.columns);
	const firstX = visibleWidth(first.slice(0, first.indexOf("alpha beta gamma")));
	const secondX = visibleWidth(second.slice(0, second.indexOf("longword")));
	terminal.emit(`\x1b[<0;${firstX + 1};${firstRow + 1}M`);
	terminal.emit(`\x1b[<32;${secondX + 2};${secondRow + 1}M`);
	const selected = result.render(terminal.columns);
	expect(selected).not.toEqual(before);
	const relativeRow = before.findIndex((line) => line.includes("longword"));
	if (relativeRow < 0) throw new Error("Expected wrapped grep result in renderer output");
	expect(selected[relativeRow]).not.toEqual(before[relativeRow]);
	tui.stop();
});

test("selectable grep/find text trims right blanks and respects collapsed rows", (): void => {
	expect(
		selectableToolText(
			{ content: [{ type: "text", text: " first   \nsecond\t \nthird" }] },
			{ expanded: false },
			2,
		),
	).toBe("first\nsecond");
});
