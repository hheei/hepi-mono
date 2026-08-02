import type { TUI } from "@earendil-works/pi-tui";
import { installMouseSupport, type TerminalMouseEvent, type TextRange } from "../src/index.js";

type InputListener = (
	data: string,
) => { readonly consume?: boolean; readonly data?: string } | undefined;

function fixture(): {
	readonly tui: TUI;
	readonly writes: string[];
	readonly listenerCount: () => number;
	input(data: string): { readonly consumed: boolean; readonly data: string };
} {
	const listeners = new Set<InputListener>();
	const writes: string[] = [];
	const tui = {
		terminal: { write: (data: string): void => void writes.push(data) },
		addInputListener(listener: InputListener): () => void {
			listeners.add(listener);
			return (): void => void listeners.delete(listener);
		},
	};
	return {
		tui: tui as unknown as TUI,
		writes,
		listenerCount: () => listeners.size,
		input(data: string): { readonly consumed: boolean; readonly data: string } {
			let current = data;
			for (const listener of listeners) {
				const result = listener(current);
				if (result?.consume === true) return { consumed: true, data: current };
				if (result?.data !== undefined) current = result.data;
			}
			return { consumed: false, data: current };
		},
	};
}

test("decodes complete SGR input and passes ordinary input through", (): void => {
	const h = fixture();
	expect(h.input("\x1b[<0;1;1M")).toEqual({ consumed: false, data: "\x1b[<0;1;1M" });
	const events: TerminalMouseEvent[] = [];
	const support = installMouseSupport(h.tui, { signal: new AbortController().signal });
	support.registerRegion({ hitTest: () => true, onMouseEvent: (event) => void events.push(event) });

	expect(h.input("x")).toEqual({ consumed: false, data: "x" });
	expect(h.input("\x1b[<20;3;4M")).toEqual({ consumed: true, data: "\x1b[<20;3;4M" });
	expect(h.input("\x1b[<64;3;4M")).toEqual({ consumed: true, data: "\x1b[<64;3;4M" });
	expect(h.input("\x1b[<0;0;4M")).toEqual({ consumed: false, data: "\x1b[<0;0;4M" });
	expect(events).toEqual([
		{ kind: "down", x: 2, y: 3, button: 0, shift: true, ctrl: true, alt: false },
	]);
});

test("enables tracking for first region and disables it after final region", (): void => {
	const h = fixture();
	const support = installMouseSupport(h.tui, { signal: new AbortController().signal });
	const first = support.registerRegion({ hitTest: () => false });
	const second = support.registerRegion({ hitTest: () => false });

	expect(h.writes).toEqual(["\x1b[?1002h\x1b[?1006h"]);
	first();
	expect(h.writes).toHaveLength(1);
	second();
	expect(h.writes).toEqual(["\x1b[?1002h\x1b[?1006h", "\x1b[?1002l\x1b[?1006l"]);
});

test("dispatches latest matching region and preserves down-region capture", (): void => {
	const h = fixture();
	const calls: string[] = [];
	const support = installMouseSupport(h.tui, { signal: new AbortController().signal });
	support.registerRegion({
		hitTest: () => true,
		onMouseEvent: (event) => void calls.push(`old:${event.kind}`),
	});
	support.registerRegion({
		hitTest: (x, y) => x === 1 && y === 1,
		onMouseEvent: (event) => void calls.push(`new:${event.kind}`),
	});

	h.input("\x1b[<0;2;2M");
	h.input("\x1b[<32;20;20M");
	h.input("\x1b[<0;20;20m");

	expect(calls).toEqual(["new:down", "new:drag", "new:up"]);
});

test("lets an ignored down fall through to the next matching region", (): void => {
	const h = fixture();
	const calls: string[] = [];
	const support = installMouseSupport(h.tui, { signal: new AbortController().signal });
	support.registerRegion({
		hitTest: () => true,
		onMouseEvent: (event) => void calls.push(`old:${event.kind}`),
	});
	support.registerRegion({
		hitTest: () => true,
		onMouseEvent: (event) => {
			calls.push(`new:${event.kind}`);
			return "ignored";
		},
	});

	h.input("\x1b[<0;1;1M");
	h.input("\x1b[<32;20;20M");
	h.input("\x1b[<0;20;20m");

	expect(calls).toEqual(["new:down", "old:down", "old:drag", "old:up"]);
});

test("drives plain-left selection without deriving copy or click behavior", (): void => {
	const h = fixture();
	const selections: (TextRange | null)[] = [];
	const custom: TerminalMouseEvent[] = [];
	const support = installMouseSupport(h.tui, { signal: new AbortController().signal });
	support.registerSelectableRegion({
		hitTest: () => true,
		hitTestText: (x) => ({ line: 0, grapheme: x }),
		setSelection: (selection) => void selections.push(selection),
		getSelectedText: () => "unused",
		onMouseEvent: (event) => void custom.push(event),
	});

	h.input("\x1b[<0;2;1M");
	h.input("\x1b[<32;5;1M");
	h.input("\x1b[<3;5;1m");
	h.input("\x1b[<4;5;1M");

	expect(selections).toEqual([
		{ start: { line: 0, grapheme: 1 }, end: { line: 0, grapheme: 1 } },
		{ start: { line: 0, grapheme: 1 }, end: { line: 0, grapheme: 4 } },
	]);
	expect(custom).toEqual([
		{ kind: "down", x: 4, y: 0, button: 0, shift: true, ctrl: false, alt: false },
	]);
});

test("isolates owners and cleans a region once across abort and stale disposers", (): void => {
	const h = fixture();
	const firstController = new AbortController();
	const first = installMouseSupport(h.tui, { signal: firstController.signal });
	const second = installMouseSupport(h.tui, { signal: new AbortController().signal });
	const calls: string[] = [];
	const old = first.registerRegion({
		hitTest: () => true,
		onMouseEvent: () => void calls.push("old"),
	});
	const secondRegion = second.registerRegion({
		hitTest: () => true,
		onMouseEvent: () => void calls.push("new"),
	});

	old();
	const current = first.registerRegion({
		hitTest: () => true,
		onMouseEvent: () => void calls.push("current"),
	});
	old();
	firstController.abort();
	h.input("\x1b[<0;1;1M");
	expect(calls).toEqual(["new"]);
	expect(h.writes).toEqual(["\x1b[?1002h\x1b[?1006h"]);

	current();
	secondRegion();
	expect(h.writes).toEqual(["\x1b[?1002h\x1b[?1006h", "\x1b[?1002l\x1b[?1006l"]);
	expect(h.input("\x1b[<0;1;1M")).toEqual({ consumed: false, data: "\x1b[<0;1;1M" });
	second.dispose();
	second.dispose();
	expect(h.listenerCount()).toBe(0);
});
