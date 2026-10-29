import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { createRenderThrottle } from "@hheei/pi-ext-core";
import { afterEach, expect, test, vi } from "vitest";
import { ToolView } from "../src/tool-view.js";

afterEach(() => vi.useRealTimers());

test("tool click reaches the native 16ms frame while a 100ms snapshot window is pending", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const terminal: Terminal = {
		start() {},
		stop() {},
		async drainInput() {},
		write: vi.fn(),
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		setProgramStatus() {},
	};
	const theme = {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	const tui = new TuiMainScreen(terminal);
	const view = new ToolView({
		theme,
		header: { title: "bash", status: "running" },
		sections: [{ railToken: "dim", content: "FULL REQUEST" }],
		invalidate: () => tui.requestRender(),
	});
	const render = vi.fn((width: number) => view.render(width));
	tui.addChild({ render, invalidate: () => view.invalidate() });
	const snapshot = vi.fn(() => tui.requestRender());
	const throttle = createRenderThrottle(snapshot);
	try {
		tui.renderNow();
		render.mockClear();
		throttle.request();
		throttle.request();
		expect(snapshot).toHaveBeenCalledTimes(1);
		view.handleMouse({
			type: "click",
			button: "left",
			x: 2,
			y: 0,
			screenX: 2,
			screenY: 0,
			width: 80,
			height: 2,
			shift: false,
			ctrl: false,
			alt: false,
		});
		await new Promise<void>((resolve) => process.nextTick(resolve));
		// Pi schedules at most one native frame interval; it may render sooner when the
		// previous frame already exhausted that interval on the real perf_hooks clock.
		vi.advanceTimersByTime(16);
		expect(render).toHaveBeenCalledTimes(1);
		expect(render.mock.results[0]?.value.join("\n")).toContain("FULL REQUEST");
		expect(snapshot).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(84);
		expect(snapshot).toHaveBeenCalledTimes(2);
		throttle.flush();
		throttle.dispose();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		vi.advanceTimersByTime(16);
		const finalFrames = render.mock.calls.length;
		vi.advanceTimersByTime(1000);
		expect(render).toHaveBeenCalledTimes(finalFrames);
	} finally {
		throttle.dispose();
		tui.stop();
	}
});
