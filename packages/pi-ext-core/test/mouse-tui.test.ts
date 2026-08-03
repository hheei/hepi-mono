import { expect, test } from "bun:test";
import { type Component, StdinBuffer, type Terminal, TUI } from "@earendil-works/pi-tui";
import { installMouseSupport } from "../src/index.js";

class RecordingTerminal implements Terminal {
	readonly writes: string[] = [];
	private readonly buffer = new StdinBuffer({ timeout: 10 });
	private readonly waiters: { readonly text: string; readonly resolve: () => void }[] = [];
	private readonly inputWaiters: { readonly data: string; readonly resolve: () => void }[] = [];

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.buffer.on("data", onInput);
		void onResize;
	}

	stop(): void {
		this.buffer.destroy();
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	write(data: string): void {
		this.writes.push(data);
		const output = this.writes.join("");
		for (const waiter of [...this.waiters]) {
			if (!output.includes(waiter.text)) continue;
			this.waiters.splice(this.waiters.indexOf(waiter), 1);
			waiter.resolve();
		}
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
		this.buffer.process(data);
	}

	waitForText(text: string): Promise<void> {
		if (this.writes.join("").includes(text)) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.waiters.push({ text, resolve });
		return promise;
	}

	waitForInput(data: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.inputWaiters.push({ data, resolve });
		return promise;
	}

	recordInput(data: string): void {
		for (const waiter of [...this.inputWaiters]) {
			if (waiter.data !== data) continue;
			this.inputWaiters.splice(this.inputWaiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	}
}

test("routes fragmented input through real TUI and redraws selection", async (): Promise<void> => {
	const terminal = new RecordingTerminal();
	const tui = new TUI(terminal);
	let selected = false;
	const keyboardInput: string[] = [];
	const component: Component = {
		render: () => [selected ? "selected" : "plain"],
		invalidate: () => undefined,
		handleInput: (data) => {
			keyboardInput.push(data);
			terminal.recordInput(data);
		},
	};
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	const support = installMouseSupport(tui, { signal: new AbortController().signal });
	support.registerSelectableRegion({
		hitTest: () => true,
		hitTestText: () => ({ line: 0, grapheme: 0 }),
		setSelection: (selection) => {
			selected = selection !== null;
		},
	});

	try {
		await terminal.waitForText("plain");
		terminal.emit("\x1b[<0");
		terminal.emit(";1;1M");
		await terminal.waitForText("selected");

		expect(selected).toBe(true);
		expect(keyboardInput).toEqual([]);
		expect(terminal.writes.join("")).toContain("selected");

		const wheel = "\x1b[<65;1;1M";
		const received = terminal.waitForInput(wheel);
		terminal.emit(wheel);
		await received;
		expect(keyboardInput).toEqual([wheel]);
	} finally {
		support.dispose();
		tui.stop();
	}
});
