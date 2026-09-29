import { type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";

// Exercise the installed renderer, not a mock screen.
function mainScreen(columns: number) {
	const terminal = {
		columns,
		rows: 10,
		kittyProtocolActive: false,
		start: vi.fn(),
		stop: vi.fn(),
		drainInput: vi.fn(async () => {}),
		write: vi.fn(),
		moveBy: vi.fn(),
		hideCursor: vi.fn(),
		showCursor: vi.fn(),
		clearLine: vi.fn(),
		clearFromCursor: vi.fn(),
		clearScreen: vi.fn(),
		setTitle: vi.fn(),
		setProgress: vi.fn(),
	} satisfies Terminal;
	const tui = new TuiMainScreen(terminal);
	const content = {
		lines: Array.from({ length: 40 }, (_, i) => `row ${i}`),
		render(): string[] {
			return this.lines;
		},
		invalidate() {},
	};
	tui.addChild(content);
	tui.renderNow();
	expect(tui.captureRenderState().previousViewportTop).toBe(30);
	terminal.write.mockClear();
	return { terminal, tui, content };
}

describe.each([24, 100])("real TUI at %i columns", (columns) => {
	test("collapsing a tool above the viewport preserves scrollback", () => {
		const { terminal, tui, content } = mainScreen(columns);
		content.lines[2] = "collapsed tool";
		tui.renderNow();
		const output = terminal.write.mock.calls.map(([data]) => data).join("");
		expect(tui.fullRedraws).toBe(2);
		expect(output).toContain("collapsed tool");
		expect(output).toContain("\x1b[2J\x1b[H");
		expect(output).not.toContain("\x1b[3J");
	});

	test("streaming changes above the viewport preserve scrollback", () => {
		const { terminal, tui, content } = mainScreen(columns);
		content.lines[2] = "streaming tool";
		tui.renderNow();
		expect(tui.fullRedraws).toBe(2);
		expect(terminal.write.mock.calls.flat().join("")).not.toContain("\x1b[3J");
	});
});
