import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { getGlobalState } from "./global-state.js";
import type { ExtensionLifecycleContext } from "./lifecycle.js";
import { type RuntimeHost, runtimeIdentity } from "./runtime-identity.js";

/**
 * Describes one Tool inventory item without assigning its effective active state.
 *
 * Loadout policy owns resolution because only it knows persisted user selections and
 * the preserved host baseline. A small priority sorts first and wins automatic
 * default conflicts; it never determines Pi tool execution order.
 */
export interface LoadoutToolMetadata {
	readonly id: string;
	readonly group: string;
	/** Exact registration provider shown by Loadout instead of Pi's broad source category. */
	readonly origin?: string;
	readonly priority: number;
	readonly conflictSets: readonly string[];
	/** Tool names that cannot be active with this tool. The relation is symmetric. */
	readonly conflictsWith?: readonly string[];
	readonly defaultActive: boolean;
	/** Capability-owned tools ignore user Loadout overrides while published. */
	readonly forcedActive?: boolean;
}

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
 * Core transports this declaration and its effective activation only. The contributor owns
 * resource policy and any future detail UI; Loadout owns persisted selection and presentation.
 */
export interface LoadoutResourceMetadata extends LoadoutToolMetadata {
	readonly kind: "agent";
	readonly label: string;
	readonly description: string;
	readonly summary: string;
	readonly projectPrivate: boolean;
	readonly owner: string;
	/** Optional contributor-owned settings/detail panel, available only while this resource exists. */
	readonly detail?: LoadoutResourceDetail;
}

export type LoadoutInventoryItem = LoadoutToolMetadata | LoadoutResourceMetadata;

/** A lifecycle-bound declaration for a tool Pi already registers elsewhere. */
export interface LoadoutInventoryRegistration extends LoadoutToolMetadata {}

/**
 * A static HEPI tool declaration. Core owns the Pi registration transport so an
 * independently loaded contributor does not depend on pi-loadout load order.
 * The owner stays stable across Pi reloads, allowing a new runner to replace the
 * old registration without allowing a second extension to claim the same name.
 */
export interface ManagedLoadoutToolRegistration extends LoadoutToolMetadata {
	readonly owner: string;
}

/** A static Pi registration whose Loadout inventory is published separately by its owner. */
export interface ManagedToolRegistration {
	readonly id: string;
	readonly owner: string;
}

export interface LoadoutInventoryObserver {
	/** Aborting the signal removes this observer; `onChange` receives an immediate snapshot. */
	readonly signal: AbortSignal;
	onChange(items: readonly LoadoutInventoryItem[]): void;
}

/** The resolved name-level activation state published by the Loadout policy owner. */
export interface LoadoutToolActivationSnapshot {
	readonly knownIds: ReadonlySet<string>;
	readonly activeIds: ReadonlySet<string>;
}

export interface LoadoutToolActivationObserver {
	/** Aborting the signal removes this observer; the latest snapshot is delivered immediately. */
	readonly signal: AbortSignal;
	onChange(snapshot: LoadoutToolActivationSnapshot | undefined): void;
}

export interface LoadoutHostObserver {
	/** Aborting the signal removes this observer; current host state arrives immediately. */
	readonly signal: AbortSignal;
	onChange(active: boolean): void;
}

interface RuntimeLoadoutState {
	readonly registrations: Map<string, LoadoutInventoryItem>;
	readonly managed: Map<string, { readonly owner: string; readonly runner: object }>;
	readonly observers: Set<LoadoutInventoryObserver>;
	activation: LoadoutToolActivationSnapshot | undefined;
	readonly activationObservers: Set<LoadoutToolActivationObserver>;
	host: object | undefined;
	readonly hostObservers: Set<LoadoutHostObserver>;
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
		registrations: new Map(),
		managed: new Map(),
		observers: new Set(),
		activation: undefined,
		activationObservers: new Set(),
		host: undefined,
		hostObservers: new Set(),
	};
	registries().byRuntime.set(identity, created);
	return created;
}

function validateMetadata(metadata: LoadoutToolMetadata): void {
	if (!metadata.id.trim()) throw new Error("Loadout tool id must not be empty");
	if (!metadata.group.trim())
		throw new Error(`Loadout tool group must not be empty: ${metadata.id}`);
	if (metadata.origin !== undefined && !metadata.origin.trim())
		throw new Error(`Loadout tool origin must not be empty: ${metadata.id}`);
	if (!Number.isSafeInteger(metadata.priority) || metadata.priority < 0)
		throw new Error(`Loadout tool priority must be a non-negative integer: ${metadata.id}`);
	for (const conflictSet of metadata.conflictSets) {
		if (!conflictSet.trim())
			throw new Error(`Loadout conflict set must not be empty: ${metadata.id}`);
	}
	for (const toolId of metadata.conflictsWith ?? []) {
		if (!toolId.trim() || toolId === metadata.id)
			throw new Error(`Loadout conflicting tool id must name another tool: ${metadata.id}`);
	}
}

function validateResourceMetadata(metadata: LoadoutResourceMetadata): void {
	validateMetadata(metadata);
	if (metadata.kind !== "agent")
		throw new Error(`Unsupported Loadout resource kind: ${metadata.kind}`);
	if (!metadata.id.startsWith(`${metadata.kind}:`))
		throw new Error(`Loadout resource id must start with ${metadata.kind}: ${metadata.id}`);
	if (!metadata.label.trim())
		throw new Error(`Loadout resource label must not be empty: ${metadata.id}`);
	if (!metadata.owner.trim())
		throw new Error(`Loadout resource owner must not be empty: ${metadata.id}`);
}

function validateManagedOwner(owner: string): void {
	if (!owner.trim()) throw new Error("Loadout managed tool owner must not be empty");
}

function validateManagedRegistration(registration: ManagedToolRegistration): void {
	if (!registration.id.trim()) throw new Error("Loadout managed tool id must not be empty");
	validateManagedOwner(registration.owner);
}

function snapshot(state: RuntimeLoadoutState): readonly LoadoutInventoryItem[] {
	return [...state.registrations.values()].sort((left, right) => left.id.localeCompare(right.id));
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

function notifyActivation(state: RuntimeLoadoutState): void {
	for (const observer of state.activationObservers) {
		if (observer.signal.aborted) continue;
		try {
			observer.onChange(state.activation);
		} catch {}
	}
}

function notifyHost(state: RuntimeLoadoutState): void {
	const active = state.host !== undefined;
	for (const observer of state.hostObservers) {
		if (observer.signal.aborted) continue;
		try {
			observer.onChange(active);
		} catch {}
	}
}

function registerMetadata(pi: RuntimeHost, metadata: LoadoutInventoryItem): void {
	validateMetadata(metadata);
	const state = stateFor(pi);
	if (state.registrations.has(metadata.id))
		throw new Error(`Loadout tool id already registered: ${metadata.id}`);
	state.registrations.set(metadata.id, metadata);
	notify(state);
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
	if (state.registrations.has(registration.id))
		throw new Error(`Loadout resource id already registered: ${registration.id}`);
	state.registrations.set(registration.id, registration);
	notify(state);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		const current = state.registrations.get(registration.id);
		if (current !== registration) return;
		state.registrations.delete(registration.id);
		notify(state);
	};
}

/** Registers an existing tool as a Loadout inventory item for this lifecycle. */
export function registerLoadoutInventory(
	context: ExtensionLifecycleContext,
	registration: LoadoutInventoryRegistration,
): void {
	registerMetadata(context.pi, registration);
	let active = true;
	context.resources.add(`loadout:${registration.id}`, () => {
		if (!active) return;
		active = false;
		const state = stateFor(context.pi);
		if (state.registrations.get(registration.id) !== registration) return;
		state.registrations.delete(registration.id);
		notify(state);
	});
}

/**
 * Registers a HEPI-owned executable tool without publishing it to Loadout inventory.
 * Registration happens during extension construction because Pi has no unregister API;
 * the stable owner permits only the same package to replace its declaration on /reload.
 */
export function registerManagedTool<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	registration: ManagedToolRegistration,
	tool: ToolDefinition<TParams, TDetails, TState>,
): void {
	validateManagedRegistration(registration);
	if (registration.id !== tool.name)
		throw new Error(`Loadout tool id must match the Pi tool name: ${registration.id}`);
	const state = stateFor(pi);
	const current = state.managed.get(registration.id);
	if (current !== undefined) {
		if (current.owner !== registration.owner)
			throw new Error(`Loadout tool id already registered: ${registration.id}`);
		if (current.runner === pi)
			throw new Error(`Loadout tool id already registered: ${registration.id}`);
		pi.registerTool(tool);
		state.managed.set(registration.id, { owner: registration.owner, runner: pi });
		return;
	}
	pi.registerTool(tool);
	state.managed.set(registration.id, { owner: registration.owner, runner: pi });
}

/** Returns whether a static Pi tool is owned by a managed Loadout contributor. */
export function isManagedLoadoutTool(pi: ExtensionAPI, id: string): boolean {
	return stateFor(pi).managed.has(id);
}

/**
 * Applies one concrete extension's runtime capability bundle without taking
 * ownership of its activation predicate or Loadout policy. The active path
 * publishes lifecycle-bound inventory; cleanup removes both inventory and tools.
 */
export function setManagedLoadoutToolsActive(
	context: ExtensionLifecycleContext,
	registrations: readonly ManagedLoadoutToolRegistration[],
	active: boolean,
): void {
	const ids = new Set<string>();
	const state = stateFor(context.pi);
	for (const registration of registrations) {
		validateMetadata(registration);
		validateManagedRegistration(registration);
		if (ids.has(registration.id))
			throw new Error(`Managed Loadout tool id is repeated: ${registration.id}`);
		ids.add(registration.id);
		const managed = state.managed.get(registration.id);
		if (managed?.owner !== registration.owner)
			throw new Error(`Managed Loadout tool is not registered by owner: ${registration.id}`);
	}

	const apply = (enabled: boolean): void => {
		const next = new Set(context.pi.getActiveTools());
		for (const id of ids) next.delete(id);
		if (enabled) for (const id of ids) next.add(id);
		context.pi.setActiveTools([...next]);
	};
	apply(active);
	if (!active) return;
	for (const registration of registrations) registerLoadoutInventory(context, registration);
	context.resources.add(`managed-loadout-tools:${[...ids].join(",")}`, () => {
		apply(false);
	});
}

/** Registers a HEPI-owned executable tool and immediately publishes its static inventory item. */
export function registerManagedLoadoutTool<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	registration: ManagedLoadoutToolRegistration,
	tool: ToolDefinition<TParams, TDetails, TState>,
): void {
	validateMetadata(registration);
	const state = stateFor(pi);
	const existing = state.registrations.get(registration.id);
	if (existing !== undefined && (!("owner" in existing) || existing.owner !== registration.owner))
		throw new Error(`Loadout tool id already registered: ${registration.id}`);
	registerManagedTool(pi, registration, tool);
	state.registrations.set(registration.id, registration);
	notify(state);
}

/** Observes the current inventory and its lifecycle-bound dynamic registrations. */
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

/** Publishes policy-resolved activation without giving core policy ownership. */
export function publishLoadoutToolActivation(
	pi: ExtensionAPI,
	snapshot: LoadoutToolActivationSnapshot,
): void {
	for (const id of snapshot.activeIds) {
		if (!snapshot.knownIds.has(id)) throw new Error(`Loadout active tool is not known: ${id}`);
	}
	const state = stateFor(pi);
	state.activation = {
		knownIds: new Set(snapshot.knownIds),
		activeIds: new Set(snapshot.activeIds),
	};
	notifyActivation(state);
}

/** Clears a policy snapshot during lifecycle teardown. */
export function clearLoadoutToolActivation(pi: ExtensionAPI): void {
	const state = stateFor(pi);
	if (state.activation === undefined) return;
	state.activation = undefined;
	notifyActivation(state);
}

/** Observes resolved activation state, including future policy changes. */
export function observeLoadoutToolActivation(
	pi: ExtensionAPI,
	observer: LoadoutToolActivationObserver,
): void {
	const state = stateFor(pi);
	if (observer.signal.aborted) return;
	state.activationObservers.add(observer);
	observer.signal.addEventListener("abort", () => state.activationObservers.delete(observer), {
		once: true,
	});
	observer.onChange(state.activation);
}

/**
 * Claims the active Loadout UI host for one lifecycle. This intentionally only
 * advertises host presence; contributors retain their own fallback settings UI.
 */
export function registerLoadoutHost(pi: ExtensionAPI): () => void {
	const state = stateFor(pi);
	if (state.host !== undefined) throw new Error("Loadout host is already active");
	const host = {};
	state.host = host;
	notifyHost(state);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		if (state.host !== host) return;
		state.host = undefined;
		notifyHost(state);
	};
}

/** Observes whether this runtime currently has an active Loadout UI host. */
export function observeLoadoutHost(pi: ExtensionAPI, observer: LoadoutHostObserver): void {
	const state = stateFor(pi);
	if (observer.signal.aborted) return;
	state.hostObservers.add(observer);
	observer.signal.addEventListener("abort", () => state.hostObservers.delete(observer), {
		once: true,
	});
	observer.onChange(state.host !== undefined);
}
