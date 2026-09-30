import type {
	ExtensionAPI,
	Theme,
	ToolDefinition,
	ToolExposure,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
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
 * owner, and core transports tool registration separately (see `registerManagedTool`).
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

/**
 * A static HEPI tool declaration. Core owns the Pi registration transport so an
 * independently loaded contributor does not depend on the host's load order.
 * The owner stays stable across Pi reloads, allowing a new runner to replace the
 * old registration without allowing a second extension to claim the same name.
 */
export interface ManagedToolRegistration {
	readonly id: string;
	readonly owner: string;
	readonly defaultActive?: boolean;
	readonly exposure?: ToolExposure;
}

export interface LoadoutInventoryObserver {
	/** Aborting the signal removes this observer; `onChange` receives an immediate snapshot. */
	readonly signal: AbortSignal;
	onChange(items: readonly LoadoutResourceMetadata[]): void;
}

interface ManagedToolRecord {
	readonly owner: string;
	readonly runner: object;
}

interface RuntimeLoadoutState {
	readonly resources: Map<string, LoadoutResourceMetadata>;
	readonly managed: Map<string, ManagedToolRecord>;
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
		managed: new Map(),
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

function validateManagedRegistration(registration: ManagedToolRegistration): void {
	if (!registration.id.trim()) throw new Error("Managed tool id must not be empty");
	if (!registration.owner.trim()) throw new Error("Managed tool owner must not be empty");
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
 * Registers a HEPI-owned executable tool. Registration happens during extension
 * construction because Pi has no unregister API; the stable owner permits only the
 * same package to replace its declaration on /reload. Loadout does not manage the
 * tool's activation, so registration carries no policy metadata.
 */
export function registerManagedTool<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	registration: ManagedToolRegistration,
	tool: ToolDefinition<TParams, TDetails, TState>,
): void {
	validateManagedRegistration(registration);
	if (registration.id !== tool.name)
		throw new Error(`Managed tool id must match the Pi tool name: ${registration.id}`);
	const state = stateFor(pi);
	const current = state.managed.get(registration.id);
	if (current !== undefined && (current.owner !== registration.owner || current.runner === pi))
		throw new Error(`Managed tool id already registered: ${registration.id}`);

	const effectiveTool: ToolDefinition<TParams, TDetails, TState> = {
		...tool,
		...(tool.defaultActive === undefined && registration.defaultActive !== undefined
			? { defaultActive: registration.defaultActive }
			: {}),
		...(tool.exposure === undefined && registration.exposure !== undefined
			? { exposure: registration.exposure }
			: {}),
	};

	pi.registerTool(effectiveTool);
	state.managed.set(registration.id, { owner: registration.owner, runner: pi });
}

/** Returns whether a Pi tool was registered through core's managed transport. */
export function isManagedTool(pi: ExtensionAPI, id: string): boolean {
	return stateFor(pi).managed.has(id);
}

/**
 * Applies one concrete extension's runtime capability bundle without taking
 * ownership of its activation predicate. The active path adds every id to Pi's
 * active set and registers a lifecycle cleanup that removes them again.
 */
export function setManagedToolsActive(
	context: ExtensionLifecycleContext,
	registrations: readonly ManagedToolRegistration[],
	active: boolean,
): void {
	const ids = new Set<string>();
	const state = stateFor(context.pi);
	for (const registration of registrations) {
		validateManagedRegistration(registration);
		if (ids.has(registration.id))
			throw new Error(`Managed tool id is repeated: ${registration.id}`);
		ids.add(registration.id);
		if (state.managed.get(registration.id)?.owner !== registration.owner)
			throw new Error(`Managed tool is not registered by owner: ${registration.id}`);
	}

	const apply = (enabled: boolean): void => {
		const next = new Set(context.pi.getActiveTools());
		for (const id of ids) next.delete(id);
		if (enabled) for (const id of ids) next.add(id);
		context.pi.setActiveTools([...next]);
	};
	apply(active);
	if (!active) return;
	addResourceCleanup(context.resources, `managed-tools:${[...ids].join(",")}`, () => apply(false));
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
