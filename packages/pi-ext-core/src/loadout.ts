import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getGlobalState } from "./global-state.js";
import type { ExtensionLifecycleContext } from "./lifecycle.js";
import { type RuntimeHost, runtimeIdentity } from "./runtime-identity.js";

/** Host operations available while a Loadout resource detail handles input. */
export interface LoadoutResourceDetailContext {
	openEditor(title: string, prefill?: string): Promise<string | undefined>;
}

/**
 * Contributor-owned view opened from its Loadout resource row. The view owns its
 * state and persistence; Loadout only supplies focus, width, and theme changes.
 * A detail may defer persistence until the Loadout page closes: `flush` is
 * invoked exactly once then, so edits stay pending while the panel is open.
 * `path` is an optional read-only backing-file hint rendered by Loadout.
 * `onScopeChange` is called when the detail is opened so contributors can
 * target per-scope save locations (e.g. project overrides).
 */
export interface LoadoutResourceDetail {
	render(width: number): readonly string[];
	handleInput(input: string, context: LoadoutResourceDetailContext): Promise<boolean> | boolean;
	/** Current buffered list-row summary; overrides static metadata while this detail is registered. */
	summary?(): string;
	onThemeChange?(theme: Theme): void;
	onScopeChange?(scope: "global" | "project"): void;
	/** Persist any pending edits; called once when the Loadout page closes. */
	flush?(): void;
	/** Read-only backing path (or future save location) shown in the header. */
	path?: string;
}

/**
 * A lifecycle-owned non-tool resource rendered and activated by Loadout.
 *
 * Loadout manages resources, never tools: the active tool set belongs to the tool
 * owner, and extensions register tools directly via Pi's `registerTool`.
 * `defaultActive` is the contributor's discovered default; the profile owner still
 * intersects the resolved state with its own settings.
 */
export interface LoadoutResourceMetadata {
	/** Stable `<kind>:<name>` id, e.g. `agent:Explore`. */
	readonly id: string;
	readonly kind: "agent";
	readonly label: string;
	readonly description: string;
	readonly summary: string;
	readonly projectPrivate: boolean;
	readonly owner: string;
	readonly defaultActive: boolean;
	/** Optional contributor-owned settings/detail panel, available only while this resource exists. */
	readonly detail?: LoadoutResourceDetail;
}

export interface LoadoutInventoryObserver {
	/** Aborting the signal removes this observer; `onChange` receives an immediate snapshot. */
	readonly signal: AbortSignal;
	onChange(items: readonly LoadoutResourceMetadata[]): void;
}

interface RuntimeLoadoutState {
	readonly resources: Map<string, LoadoutResourceMetadata>;
	readonly observers: Set<LoadoutInventoryObserver>;
}

interface RuntimeLoadoutRegistries {
	readonly byRuntime: WeakMap<object, RuntimeLoadoutState>;
}

function registries(): RuntimeLoadoutRegistries {
	return getGlobalState("loadout-registries", () => ({ byRuntime: new WeakMap() }));
}

function stateFor(pi: RuntimeHost): RuntimeLoadoutState {
	const identity = runtimeIdentity(pi);
	const existing = registries().byRuntime.get(identity);
	if (existing !== undefined) return existing;
	const created: RuntimeLoadoutState = {
		resources: new Map(),
		observers: new Set(),
	};
	registries().byRuntime.set(identity, created);
	return created;
}

function validateResourceMetadata(metadata: LoadoutResourceMetadata): void {
	if (!metadata.id.trim()) throw new Error("Loadout resource id must not be empty");
	if (metadata.kind !== "agent")
		throw new Error(`Unsupported Loadout resource kind: ${metadata.kind}`);
	if (!metadata.id.startsWith(`${metadata.kind}:`))
		throw new Error(`Loadout resource id must start with ${metadata.kind}: ${metadata.id}`);
	if (!metadata.label.trim())
		throw new Error(`Loadout resource label must not be empty: ${metadata.id}`);
	if (!metadata.owner.trim())
		throw new Error(`Loadout resource owner must not be empty: ${metadata.id}`);
}

function snapshot(state: RuntimeLoadoutState): readonly LoadoutResourceMetadata[] {
	return [...state.resources.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function notify(state: RuntimeLoadoutState): void {
	const items = snapshot(state);
	for (const observer of state.observers) {
		if (observer.signal.aborted) continue;
		try {
			observer.onChange(items);
		} catch {}
	}
}

function addResourceCleanup(
	resources: ExtensionLifecycleContext["resources"],
	id: string,
	cleanup: () => void,
): void {
	try {
		resources.add(id, cleanup);
	} catch (error) {
		if (error instanceof Error && error.message === `Cleanup id already registered: ${id}`) return;
		throw error;
	}
}

/**
 * Registers a dynamic non-tool resource. The returned disposer removes precisely this declaration;
 * callers retain it and release it on discovery changes and lifecycle shutdown.
 */
export function registerLoadoutResource(
	pi: ExtensionAPI,
	registration: LoadoutResourceMetadata,
): () => void {
	validateResourceMetadata(registration);
	const state = stateFor(pi);
	if (state.resources.has(registration.id))
		throw new Error(`Loadout resource id already registered: ${registration.id}`);
	state.resources.set(registration.id, registration);
	notify(state);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		const current = state.resources.get(registration.id);
		if (current !== registration) return;
		state.resources.delete(registration.id);
		notify(state);
	};
}

/**
 * Toggles a set of tool names in Pi's active tools for the given session lifecycle context.
 * When active, adds the tools and registers a lifecycle resource cleanup that removes them on session exit.
 * When inactive, removes the tools from Pi's active tools.
 */
export function setSessionToolsActive(
	context: ExtensionLifecycleContext,
	toolNames: readonly string[],
	active: boolean,
): void {
	const ids = [...new Set(toolNames)];
	const apply = (enabled: boolean): void => {
		const next = new Set(context.pi.getActiveTools());
		for (const id of ids) next.delete(id);
		if (enabled) for (const id of ids) next.add(id);
		context.pi.setActiveTools([...next]);
	};
	apply(active);
	if (!active) return;
	addResourceCleanup(context.resources, `session-tools:${ids.join(",")}`, () => apply(false));
}

/** Observes the current resource inventory and its lifecycle-bound dynamic registrations. */
export function observeLoadoutInventory(
	pi: ExtensionAPI,
	observer: LoadoutInventoryObserver,
): void {
	const state = stateFor(pi);
	if (observer.signal.aborted) return;
	state.observers.add(observer);
	const remove = () => state.observers.delete(observer);
	observer.signal.addEventListener("abort", remove, { once: true });
	observer.onChange(snapshot(state));
}
