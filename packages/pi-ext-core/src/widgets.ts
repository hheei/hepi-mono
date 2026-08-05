import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { getGlobalState } from "./global-state.js";
import { runtimeIdentity } from "./runtime-identity.js";

export type HepiWidgetPlacement = "aboveEditor" | "belowEditor";

type WidgetComponent = Component & { dispose?(): void };

/** Contributor declaration for one core-managed editor-adjacent widget. */
export interface HepiWidgetRegistration {
	/** Runtime-unique stable Pi widget key. */
	readonly id: string;
	readonly placement: HepiWidgetPlacement;
	/** Starts hidden when feature-owned presentation has no visible content yet. */
	readonly visible?: boolean;
	/** Creates visible content only while core has mounted this contributor. */
	create(tui: TUI, theme: Theme): WidgetComponent;
}

/** Feature-owned presentation handle. Core retains Pi transport and suspension policy. */
export interface HepiWidgetHandle {
	/** Mounts or unmounts this contributor without changing feature-owned model state. */
	setVisible(visible: boolean): void;
	/** Requests a visible component render, remounting after Pi invalidates it. */
	requestRender(force?: boolean): void;
	/** Idempotently removes this exact contributor and its abort listener. */
	dispose(): void;
}

/** A reference-counted Settings-host lease that suppresses all core-managed widgets. */
export interface HepiWidgetSuspension {
	/** Releases this lease; widgets return only after the final lease is released. */
	release(): void;
}

interface WidgetEntry {
	readonly registration: HepiWidgetRegistration;
	readonly extension: ExtensionContext;
	readonly signal: AbortSignal;
	readonly onAbort: () => void;
	visible: boolean;
	mounted: boolean;
	invalidated: boolean;
	disposed: boolean;
	tui: TUI | undefined;
}

interface WidgetState {
	readonly entries: Map<string, WidgetEntry>;
	suspensions: number;
}

function stateFor(pi: ExtensionAPI): WidgetState {
	const states = getGlobalState(
		"hepi-widget-states",
		(): WeakMap<object, WidgetState> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const current = states.get(identity);
	if (current !== undefined) return current;
	const created: WidgetState = { entries: new Map(), suspensions: 0 };
	states.set(identity, created);
	return created;
}

function unmount(entry: WidgetEntry): void {
	if (!entry.mounted) return;
	entry.extension.ui.setWidget(entry.registration.id, undefined, {
		placement: entry.registration.placement,
	});
	entry.mounted = false;
	entry.invalidated = false;
	entry.tui = undefined;
}

function reconcile(state: WidgetState, entry: WidgetEntry): void {
	if (entry.disposed || !entry.visible || state.suspensions > 0) {
		unmount(entry);
		return;
	}
	if (entry.mounted && !entry.invalidated) return;
	entry.extension.ui.setWidget(
		entry.registration.id,
		(tui, theme): WidgetComponent => {
			entry.tui = tui;
			const component = entry.registration.create(tui, theme);
			return {
				...component,
				invalidate: () => {
					entry.invalidated = true;
					entry.tui = undefined;
					component.invalidate();
				},
				dispose: () => {
					entry.invalidated = true;
					entry.tui = undefined;
					component.dispose?.();
				},
			};
		},
		{ placement: entry.registration.placement },
	);
	entry.mounted = true;
	entry.invalidated = false;
}

function reconcileAll(state: WidgetState): void {
	for (const entry of state.entries.values()) reconcile(state, entry);
}

/**
 * Registers one lifecycle-owned widget through core. Contributors never call Pi's
 * `setWidget()` directly: core keeps the factory so Settings can suspend and later
 * restore all registered widgets without understanding feature state. The caller's
 * signal and explicit handle disposal are both idempotent cleanup paths.
 */
export function registerHepiWidget(
	pi: ExtensionAPI,
	extension: ExtensionContext,
	signal: AbortSignal,
	registration: HepiWidgetRegistration,
): HepiWidgetHandle {
	if (!registration.id.trim()) throw new Error("HEPI widget id must not be empty");
	const state = stateFor(pi);
	if (state.entries.has(registration.id))
		throw new Error(`HEPI widget id collision: ${registration.id}`);

	let entry: WidgetEntry;
	const dispose = (): void => {
		if (entry.disposed) return;
		entry.disposed = true;
		entry.signal.removeEventListener("abort", entry.onAbort);
		unmount(entry);
		if (state.entries.get(registration.id) === entry) state.entries.delete(registration.id);
	};
	const onAbort = (): void => dispose();
	entry = {
		registration,
		extension,
		signal,
		onAbort,
		visible: extension.mode === "tui" && registration.visible !== false,
		mounted: false,
		invalidated: false,
		disposed: false,
		tui: undefined,
	};
	state.entries.set(registration.id, entry);
	signal.addEventListener("abort", onAbort, { once: true });
	reconcile(state, entry);

	return {
		setVisible(visible): void {
			if (entry.disposed || entry.visible === visible) return;
			entry.visible = visible;
			reconcile(state, entry);
		},
		requestRender(force = false): void {
			if (entry.disposed || !entry.visible || state.suspensions > 0) return;
			if (entry.invalidated) reconcile(state, entry);
			entry.tui?.requestRender(force);
		},
		dispose,
	};
}

/**
 * Temporarily hides every widget registered through this core runtime. Leases are
 * reference-counted so overlapping Settings surfaces cannot restore widgets early;
 * direct Pi widgets remain outside this contract and are intentionally untouched.
 */
export function suspendHepiWidgets(pi: ExtensionAPI): HepiWidgetSuspension {
	const state = stateFor(pi);
	state.suspensions++;
	reconcileAll(state);
	let released = false;
	return {
		release(): void {
			if (released) return;
			released = true;
			state.suspensions--;
			if (state.suspensions === 0) reconcileAll(state);
		},
	};
}
