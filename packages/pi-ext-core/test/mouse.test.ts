import type { TUI } from "@earendil-works/pi-tui";
import { getGlobalState } from "../src/global-state.js";
import { installMouseSupport, type TerminalMouseEvent, type TextRange } from "../src/index.js";

type InputListener = (
	data: string,
) => { readonly consume?: boolean; readonly data?: string } | undefined;

interface DispatcherState {
	tracking: boolean;
	pendingDisable: boolean;
}

function dispatcherState(tui: TUI): DispatcherState {
	const states = getGlobalState(
		"mouse-dispatchers",
		(): WeakMap<TUI, DispatcherState> => new WeakMap(),
	);
	const state = states.get(tui);
	if (state === undefined) throw new Error("Expected mouse dispatcher");
	return state;
}

function fixture(): {
	readonly tui: TUI;
	readonly writes: string[];
	readonly renderRequests: number;
	readonly listenerCount: () => number;
	readonly setWriteFailure: (enabled: boolean) => void;
	input(data: string): { readonly consumed: boolean; readonly data: string };
} {
	const listeners = new Set<InputListener>();
	const writes: string[] = [];
	let renderRequests = 0;
	let writeFailure = false;
	const tui = {
		terminal: {
			write: (data: string): void => {
				if (writeFailure) throw new Error("terminal write failed");
				writes.push(data);
			},
		},
		requestRender: (): void => {
			renderRequests++;
		},
		addInputListener(listener: InputListener): () => void {
			listeners.add(listener);
			return (): void => void listeners.delete(listener);
		},
	};
	return {
		tui: tui as unknown as TUI,
		writes,
		get renderRequests(): number {
			return renderRequests;
		},
		listenerCount: () => listeners.size,
		setWriteFailure: (enabled): void => {
			writeFailure = enabled;
		},
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

test("keeps down dispatch stable when ignored callback removes an earlier region", (): void => {
	const h = fixture();
	const support = installMouseSupport(h.tui, { signal: new AbortController().signal });
	const calls: string[] = [];
	const removeOld = support.registerRegion({
		hitTest: () => true,
		onMouseEvent: (event) => void calls.push(`old:${event.kind}`),
	});
	support.registerRegion({
		hitTest: () => true,
		onMouseEvent: (event) => {
			calls.push(`new:${event.kind}`);
			removeOld();
			return "ignored";
		},
	});

	h.input("\x1b[<0;1;1M");

	expect(calls).toEqual(["new:down"]);
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
	expect(h.renderRequests).toBe(2);
});

test("does not capture a region disposed synchronously by down", (): void => {
	const h = fixture();
	const support = installMouseSupport(h.tui, { signal: new AbortController().signal });
	const calls: string[] = [];
	support.registerRegion({
		hitTest: () => true,
		onMouseEvent: (event) => {
			calls.push(event.kind);
			if (event.kind === "down") support.dispose();
		},
	});

	h.input("\x1b[<0;1;1M");
	h.input("\x1b[<32;2;2M");
	h.input("\x1b[<0;2;2m");

	expect(calls).toEqual(["down"]);
	expect(h.listenerCount()).toBe(0);
});

test("does not capture a selectable region disposed by setSelection", (): void => {
	const h = fixture();
	const support = installMouseSupport(h.tui, { signal: new AbortController().signal });
	let selections = 0;
	support.registerSelectableRegion({
		hitTest: () => true,
		hitTestText: () => ({ line: 0, grapheme: 0 }),
		setSelection: () => {
			selections++;
			support.dispose();
		},
		getSelectedText: () => "unused",
	});

	h.input("\x1b[<0;1;1M");
	h.input("\x1b[<32;2;2M");
	h.input("\x1b[<0;2;2m");

	expect(selections).toBe(1);
	expect(h.renderRequests).toBe(1);
	expect(h.listenerCount()).toBe(0);
});

test("rolls back tracking state when terminal writes fail", (): void => {
	const h = fixture();
	const support = installMouseSupport(h.tui, { signal: new AbortController().signal });
	const region = { hitTest: () => false };

	h.setWriteFailure(true);
	expect(() => support.registerRegion(region)).toThrow("terminal write failed");
	expect(h.writes).toEqual([]);
	h.setWriteFailure(false);
	const remove = support.registerRegion(region);
	expect(h.writes).toEqual(["\x1b[?1002h\x1b[?1006h"]);

	h.setWriteFailure(true);
	expect(() => remove()).toThrow("terminal write failed");
	h.setWriteFailure(false);
	remove();
	expect(h.writes).toEqual(["\x1b[?1002h\x1b[?1006h", "\x1b[?1002l\x1b[?1006l"]);
	support.dispose();
});

test("forces terminal cleanup after abort disables tracking unsuccessfully", (): void => {
	const h = fixture();
	const controller = new AbortController();
	const support = installMouseSupport(h.tui, { signal: controller.signal });
	support.registerRegion({ hitTest: () => false });

	h.setWriteFailure(true);
	expect(() => controller.abort()).not.toThrow();
	expect(h.listenerCount()).toBe(0);
	expect(() => support.registerRegion({ hitTest: () => false })).toThrow(
		"Mouse support is disposed",
	);
	expect(() => support.dispose()).toThrow("terminal write failed");

	h.setWriteFailure(false);
	const replacement = installMouseSupport(h.tui, { signal: new AbortController().signal });
	expect(h.writes).toEqual(["\x1b[?1002h\x1b[?1006h", "\x1b[?1002l\x1b[?1006l"]);
	const remove = replacement.registerRegion({ hitTest: () => false });
	expect(h.writes).toEqual([
		"\x1b[?1002h\x1b[?1006h",
		"\x1b[?1002l\x1b[?1006l",
		"\x1b[?1002h\x1b[?1006h",
	]);
	remove();
	replacement.dispose();
});

test("keeps live owner tracking when another owner aborts before install", (): void => {
	const h = fixture();
	const firstController = new AbortController();
	const first = installMouseSupport(h.tui, { signal: firstController.signal });
	const second = installMouseSupport(h.tui, { signal: new AbortController().signal });
	const calls: string[] = [];
	first.registerRegion({ hitTest: () => true, onMouseEvent: () => void calls.push("first") });
	second.registerRegion({ hitTest: () => true, onMouseEvent: () => void calls.push("second") });

	h.setWriteFailure(true);
	firstController.abort();
	h.setWriteFailure(false);
	const third = installMouseSupport(h.tui, { signal: new AbortController().signal });
	third.registerRegion({ hitTest: () => false });
	h.input("\x1b[<0;1;1M");

	expect(calls).toEqual(["second"]);
	expect(h.writes).toEqual(["\x1b[?1002h\x1b[?1006h"]);
	second.dispose();
	third.dispose();
});

test("resets pending transport before exposing a new owner beside a live region", (): void => {
	const h = fixture();
	const firstController = new AbortController();
	const first = installMouseSupport(h.tui, { signal: firstController.signal });
	const second = installMouseSupport(h.tui, { signal: new AbortController().signal });
	const calls: string[] = [];
	first.registerRegion({ hitTest: () => false });
	second.registerRegion({ hitTest: () => true, onMouseEvent: () => void calls.push("second") });
	firstController.abort();

	// This is the retained reset obligation from a failed transport cleanup. The
	// neighboring live region models the state an install must reconcile safely.
	const state = dispatcherState(h.tui);
	state.tracking = false;
	state.pendingDisable = true;
	first.dispose();
	const third = installMouseSupport(h.tui, { signal: new AbortController().signal });
	third.registerRegion({ hitTest: () => false });
	h.input("\x1b[<0;1;1M");

	expect(h.writes).toEqual([
		"\x1b[?1002h\x1b[?1006h",
		"\x1b[?1002l\x1b[?1006l",
		"\x1b[?1002h\x1b[?1006h",
	]);
	expect(calls).toEqual(["second"]);
	second.dispose();
	third.dispose();
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

test("does not let an old handle delete a newer dispatcher state", (): void => {
	const h = fixture();
	const old = installMouseSupport(h.tui, { signal: new AbortController().signal });
	old.registerRegion({ hitTest: () => false });
	old.dispose();

	const calls: string[] = [];
	const live = installMouseSupport(h.tui, { signal: new AbortController().signal });
	live.registerRegion({ hitTest: () => true, onMouseEvent: () => void calls.push("live") });
	old.dispose();
	const replacement = installMouseSupport(h.tui, { signal: new AbortController().signal });
	replacement.registerRegion({ hitTest: () => false });
	h.input("\x1b[<0;1;1M");

	expect(h.listenerCount()).toBe(1);
	expect(calls).toEqual(["live"]);
	expect(h.writes).toEqual([
		"\x1b[?1002h\x1b[?1006h",
		"\x1b[?1002l\x1b[?1006l",
		"\x1b[?1002h\x1b[?1006h",
	]);
	live.dispose();
	replacement.dispose();
});
