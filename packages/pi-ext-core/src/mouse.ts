import type { TUI } from "@earendil-works/pi-tui";
import { getGlobalState } from "./global-state.js";

const ENABLE_MOUSE_TRACKING = "\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE_TRACKING = "\x1b[?1002l\x1b[?1006l";

// biome-ignore lint/suspicious/noConfusingVoidType: observers may intentionally return no result
type MouseEventResult = "handled" | "ignored" | void;

/**
 * Normalized SGR mouse input in viewport cell coordinates. `button` is the
 * SGR low-two-bit button code: 0/1/2 are primary/middle/secondary and 3 is
 * the terminal's release code, commonly used on `up`; wheel reports are
 * consumed but intentionally have no public event kind in v1.
 */
export interface TerminalMouseEvent {
	readonly kind: "down" | "drag" | "up";
	readonly x: number;
	readonly y: number;
	readonly button: number;
	readonly shift: boolean;
	readonly ctrl: boolean;
	readonly alt: boolean;
}

/** Zero-based insertion position in one page-owned selection content model. */
export interface TextPosition {
	readonly line: number;
	readonly grapheme: number;
}

/** Half-open range in one page-owned selection content model. */
export interface TextRange {
	readonly start: TextPosition;
	readonly end: TextPosition;
}

export interface MouseRegion {
	/** Update this registration only when the page's layout snapshot changes, not while rendering. */
	hitTest(x: number, y: number): boolean;
	/**
	 * Handles non-default gestures. Returning `"ignored"` from `down` lets
	 * dispatch continue to the next matching layer; `"handled"` or no result
	 * captures this region. Generic callbacks own their `tui.requestRender()`.
	 */
	onMouseEvent?(event: TerminalMouseEvent): MouseEventResult;
}

/**
 * Page-owned mapping and selection state for one logical text surface. Core
 * requests a render after each `setSelection()` call; the page owns content,
 * clipping, and selected-text extraction.
 */
export interface SelectableRegion extends MouseRegion {
	hitTestText(x: number, y: number): TextPosition | null;
	setSelection(selection: TextRange | null): void;
	getSelectedText(selection: TextRange): string;
}

/**
 * Owner-scoped mouse lease. Registration disposers, abort, and `dispose()` are
 * idempotent; registrations belong to layout snapshots and capture ends with
 * the owning region or its gesture.
 */
export interface MouseSupport {
	/** Registers a layout-snapshot region; disposer removes it and any capture. */
	registerRegion(region: MouseRegion): () => void;
	/** Registers a page-owned text mapping; core drives selection and render requests. */
	registerSelectableRegion(region: SelectableRegion): () => void;
	/** Releases this owner's regions, listener lease, and abort subscription. */
	dispose(): void;
}

interface Owner {
	disposed: boolean;
	readonly entries: Set<RegisteredRegion>;
	readonly signal: AbortSignal;
	onAbort: () => void;
}

interface RegisteredRegion {
	active: boolean;
	readonly owner: Owner;
	readonly region: MouseRegion;
	readonly selectable: SelectableRegion | undefined;
}

interface SelectionGesture {
	readonly anchor: TextPosition | undefined;
}

interface CapturedGesture {
	readonly entry: RegisteredRegion;
	readonly selection: SelectionGesture | undefined;
}

interface MouseDispatcher {
	readonly tui: TUI;
	readonly owners: Set<Owner>;
	readonly entries: RegisteredRegion[];
	removeInputListener: () => void;
	tracking: boolean;
	captured: CapturedGesture | undefined;
}

type ParsedMouseInput =
	| { readonly kind: "event"; readonly event: TerminalMouseEvent }
	| { readonly kind: "unsupported" };

function setTracking(dispatcher: MouseDispatcher, enabled: boolean): void {
	if (dispatcher.tracking === enabled) return;
	// The lease temporarily gives this surface terminal mouse ownership, so
	// native terminal selection may change. Reference counting restores Pi's
	// default behavior as soon as its final region disappears.
	dispatcher.tui.terminal.write(enabled ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING);
	dispatcher.tracking = enabled;
}

function updateTracking(dispatcher: MouseDispatcher): void {
	setTracking(dispatcher, dispatcher.entries.length > 0);
}

function readDecimal(data: string, index: number): readonly [number, number] | undefined {
	let value = 0;
	let digitCount = 0;
	for (; index < data.length; index++) {
		const code = data.charCodeAt(index);
		if (code < 48 || code > 57) break;
		if (value > (Number.MAX_SAFE_INTEGER - (code - 48)) / 10) return undefined;
		value = value * 10 + (code - 48);
		digitCount++;
	}
	return digitCount === 0 ? undefined : [value, index];
}

/**
 * Pi's StdinBuffer already supplies one complete input sequence. Keep ordinary
 * keyboard input on this prefix-only fast path: mouse parsing must not add a
 * buffer, timer, allocation, or I/O cost to the dominant input path.
 */
function parseSgrMouseInput(data: string): ParsedMouseInput | undefined {
	if (
		data.length < 8 ||
		data.charCodeAt(0) !== 27 ||
		data.charCodeAt(1) !== 91 ||
		data.charCodeAt(2) !== 60
	)
		return undefined;

	const control = readDecimal(data, 3);
	if (control === undefined || data.charCodeAt(control[1]) !== 59) return undefined;
	const column = readDecimal(data, control[1] + 1);
	if (column === undefined || data.charCodeAt(column[1]) !== 59) return undefined;
	const row = readDecimal(data, column[1] + 1);
	if (row === undefined || row[1] !== data.length - 1) return undefined;

	const terminator = data.charCodeAt(row[1]);
	if (terminator !== 77 && terminator !== 109) return undefined;
	if (control[0] > 127 || column[0] === 0 || row[0] === 0) return undefined;

	// Wheel reports share SGR syntax but have no public event kind in v1.
	if ((control[0] & 64) !== 0) return { kind: "unsupported" };
	return {
		kind: "event",
		event: {
			kind: terminator === 109 ? "up" : (control[0] & 32) !== 0 ? "drag" : "down",
			x: column[0] - 1,
			y: row[0] - 1,
			button: control[0] & 3,
			shift: (control[0] & 4) !== 0,
			alt: (control[0] & 8) !== 0,
			ctrl: (control[0] & 16) !== 0,
		},
	};
}

function comparePositions(left: TextPosition, right: TextPosition): number {
	return left.line === right.line ? left.grapheme - right.grapheme : left.line - right.line;
}

function selectionRange(anchor: TextPosition, endpoint: TextPosition): TextRange {
	return comparePositions(anchor, endpoint) <= 0
		? { start: anchor, end: endpoint }
		: { start: endpoint, end: anchor };
}

function isPlainLeftButton(event: TerminalMouseEvent): boolean {
	return event.button === 0 && !event.shift && !event.ctrl && !event.alt;
}

function dispatchSelectableEvent(
	tui: TUI,
	selectable: SelectableRegion,
	event: TerminalMouseEvent,
	selection: SelectionGesture | undefined,
): SelectionGesture | undefined {
	// SGR release commonly reports button 3. A plain-left capture must end
	// without invoking the custom callback or changing its last valid position.
	if (event.kind === "up" && selection !== undefined) return selection;
	if (!isPlainLeftButton(event)) {
		selectable.onMouseEvent?.(event);
		return undefined;
	}
	const position = selectable.hitTestText(event.x, event.y);
	if (event.kind === "down") {
		if (position === null) return { anchor: undefined };
		selectable.setSelection({ start: position, end: position });
		// TUI consumes mouse input before its focused component's automatic
		// render request; selection changes therefore request rendering here.
		tui.requestRender();
		return { anchor: position };
	}
	if (position !== null && selection?.anchor !== undefined) {
		selectable.setSelection(selectionRange(selection.anchor, position));
		tui.requestRender();
	}
	return selection;
}

function dispatchCapturedEvent(
	dispatcher: MouseDispatcher,
	captured: CapturedGesture,
	event: TerminalMouseEvent,
): void {
	const selectable = captured.entry.selectable;
	if (selectable === undefined) captured.entry.region.onMouseEvent?.(event);
	else dispatchSelectableEvent(dispatcher.tui, selectable, event, captured.selection);
}

function dispatchMouseEvent(dispatcher: MouseDispatcher, event: TerminalMouseEvent): void {
	// Registry order is the layout snapshot order. Reverse scanning gives the
	// newest owner precedence; an explicitly ignored down exposes the next
	// matching layer, while capture prevents later hit tests mid-gesture.
	if (event.kind !== "down") {
		const captured = dispatcher.captured;
		if (captured === undefined) return;
		dispatchCapturedEvent(dispatcher, captured, event);
		if (event.kind === "up") dispatcher.captured = undefined;
		return;
	}

	dispatcher.captured = undefined;
	for (let index = dispatcher.entries.length - 1; index >= 0; index--) {
		const entry = dispatcher.entries[index];
		if (entry === undefined || !entry.active || !entry.region.hitTest(event.x, event.y)) continue;
		if (entry.selectable === undefined) {
			const result = entry.region.onMouseEvent?.(event);
			// Callback may synchronously abort/dispose this owner or its region.
			// Never resurrect capture for an entry removed during that callback.
			if (!entry.active || entry.owner.disposed) continue;
			if (result === "ignored") continue;
			dispatcher.captured = { entry, selection: undefined };
			return;
		}
		if (!isPlainLeftButton(event)) {
			const result = entry.selectable.onMouseEvent?.(event);
			if (!entry.active || entry.owner.disposed) continue;
			if (result === "ignored") continue;
			dispatcher.captured = { entry, selection: undefined };
			return;
		}
		const selection = dispatchSelectableEvent(dispatcher.tui, entry.selectable, event, undefined);
		if (!entry.active || entry.owner.disposed) continue;
		dispatcher.captured = { entry, selection };
		return;
	}
}

function createDispatcher(tui: TUI): MouseDispatcher {
	/**
	 * TUI is the input boundary: its StdinBuffer has already joined fragmented
	 * stdin chunks, and addInputListener is the supported hook. Reading stdin
	 * here or creating another parser would race Pi's keyboard handling.
	 */
	const dispatcher: MouseDispatcher = {
		tui,
		owners: new Set<Owner>(),
		entries: [],
		removeInputListener: () => undefined,
		tracking: false,
		captured: undefined,
	};
	dispatcher.removeInputListener = tui.addInputListener((data) => {
		if (dispatcher.entries.length === 0) return undefined;
		const parsed = parseSgrMouseInput(data);
		if (parsed === undefined) return undefined;
		if (parsed.kind === "event") dispatchMouseEvent(dispatcher, parsed.event);
		return { consume: true };
	});
	return dispatcher;
}

function removeRegion(dispatcher: MouseDispatcher, entry: RegisteredRegion): void {
	if (!entry.active) return;
	const index = dispatcher.entries.indexOf(entry);
	const previousCapture = dispatcher.captured?.entry === entry ? dispatcher.captured : undefined;
	entry.active = false;
	entry.owner.entries.delete(entry);
	if (index >= 0) dispatcher.entries.splice(index, 1);
	if (previousCapture !== undefined) dispatcher.captured = undefined;
	try {
		updateTracking(dispatcher);
	} catch (error) {
		// Keep lease ownership and capture intact when terminal cleanup fails;
		// caller can retry the same idempotent disposer after the terminal recovers.
		entry.active = true;
		entry.owner.entries.add(entry);
		if (index >= 0) dispatcher.entries.splice(index, 0, entry);
		if (previousCapture !== undefined) dispatcher.captured = previousCapture;
		throw error;
	}
}

/**
 * Installs owner-scoped terminal mouse support for one surface. The surface owns
 * layout snapshots and selection policy; core only shares transport and capture.
 * Without an explicit install the TUI input path is untouched. Repeated installs
 * share one dispatcher while retaining owner isolation. Abort, owner disposal,
 * reload, and surface close converge on idempotent cleanup, so an obsolete
 * disposer cannot remove another owner's newer registration.
 */
export function installMouseSupport(
	tui: TUI,
	options: { readonly signal: AbortSignal },
): MouseSupport {
	if (options.signal.aborted) return closedMouseSupport();

	const state = getGlobalState(
		"mouse-dispatchers",
		(): WeakMap<TUI, MouseDispatcher> => new WeakMap(),
	);
	let dispatcher = state.get(tui);
	if (dispatcher === undefined) {
		dispatcher = createDispatcher(tui);
		state.set(tui, dispatcher);
	}

	let owner: Owner;
	const dispose = (): void => {
		if (owner.disposed) return;
		for (const entry of [...owner.entries]) removeRegion(dispatcher, entry);
		owner.disposed = true;
		owner.signal.removeEventListener("abort", owner.onAbort);
		dispatcher.owners.delete(owner);
		if (dispatcher.owners.size > 0) return;
		dispatcher.removeInputListener();
		state.delete(tui);
	};
	owner = {
		disposed: false,
		entries: new Set<RegisteredRegion>(),
		signal: options.signal,
		onAbort: dispose,
	};
	dispatcher.owners.add(owner);
	options.signal.addEventListener("abort", owner.onAbort, { once: true });

	const register = (
		region: MouseRegion,
		selectable: SelectableRegion | undefined,
	): (() => void) => {
		if (owner.disposed) throw new Error("Mouse support is disposed");
		const entry: RegisteredRegion = { active: true, owner, region, selectable };
		owner.entries.add(entry);
		dispatcher.entries.push(entry);
		try {
			updateTracking(dispatcher);
		} catch (error) {
			entry.active = false;
			owner.entries.delete(entry);
			const index = dispatcher.entries.indexOf(entry);
			if (index >= 0) dispatcher.entries.splice(index, 1);
			throw error;
		}
		return (): void => removeRegion(dispatcher, entry);
	};

	return {
		registerRegion: (region): (() => void) => register(region, undefined),
		registerSelectableRegion: (region): (() => void) => register(region, region),
		dispose,
	};
}

function closedMouseSupport(): MouseSupport {
	const register = (): never => {
		throw new Error("Mouse support is disposed");
	};
	return { registerRegion: register, registerSelectableRegion: register, dispose: () => undefined };
}
