import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
	readonly priority: number;
	readonly conflictSets: readonly string[];
	readonly defaultActive: boolean;
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

interface RuntimeLoadoutState {
	readonly registrations: Map<string, LoadoutInventoryItem>;
	readonly managed: Map<string, { readonly owner: string; readonly runner: object }>;
	readonly observers: Set<LoadoutInventoryObserver>;
	activation: LoadoutToolActivationSnapshot | undefined;
	readonly activationObservers: Set<LoadoutToolActivationObserver>;
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
	};
	registries().byRuntime.set(identity, created);
	return created;
}

function validateMetadata(metadata: LoadoutToolMetadata): void {
	if (!metadata.id.trim()) throw new Error("Loadout tool id must not be empty");
	if (!metadata.group.trim())
		throw new Error(`Loadout tool group must not be empty: ${metadata.id}`);
	if (!Number.isSafeInteger(metadata.priority) || metadata.priority < 0)
		throw new Error(`Loadout tool priority must be a non-negative integer: ${metadata.id}`);
	for (const conflictSet of metadata.conflictSets) {
		if (!conflictSet.trim())
			throw new Error(`Loadout conflict set must not be empty: ${metadata.id}`);
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

function snapshot(state: RuntimeLoadoutState): readonly LoadoutInventoryItem[] {
	return [...state.registrations.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function notify(state: RuntimeLoadoutState): void {
	const items = snapshot(state);
	for (const observer of state.observers) {
		if (!observer.signal.aborted) observer.onChange(items);
	}
}

function notifyActivation(state: RuntimeLoadoutState): void {
	for (const observer of state.activationObservers) {
		if (!observer.signal.aborted) observer.onChange(state.activation);
	}
}

function registerMetadata(pi: RuntimeHost, metadata: LoadoutInventoryItem): void {
	validateMetadata(metadata);
	const state = stateFor(pi);
	if (state.registrations.has(metadata.id))
		throw new Error(`Loadout tool id already registered: ${metadata.id}`);
	state.registrations.set(metadata.id, metadata);
	try {
		notify(state);
	} catch (error) {
		state.registrations.delete(metadata.id);
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
	if (state.registrations.has(registration.id))
		throw new Error(`Loadout resource id already registered: ${registration.id}`);
	state.registrations.set(registration.id, registration);
	try {
		notify(state);
	} catch (error) {
		state.registrations.delete(registration.id);
		throw error;
	}
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
 * Registers a HEPI-owned executable tool and its corresponding static inventory item.
 * Registration happens during extension construction because Pi has no unregister API;
 * the stable owner permits only the same package to replace its declaration on /reload.
 */
export function registerManagedLoadoutTool<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	registration: ManagedLoadoutToolRegistration,
	tool: ToolDefinition<TParams, TDetails, TState>,
): void {
	validateMetadata(registration);
	validateManagedOwner(registration.owner);
	if (registration.id !== tool.name)
		throw new Error(`Loadout tool id must match the Pi tool name: ${registration.id}`);
	const state = stateFor(pi);
	const current = state.managed.get(registration.id);
	if (current !== undefined) {
		if (current.owner !== registration.owner)
			throw new Error(`Loadout tool id already registered: ${registration.id}`);
		if (current.runner === pi)
			throw new Error(`Loadout tool id already registered: ${registration.id}`);
		const previous = state.registrations.get(registration.id);
		pi.registerTool(tool);
		state.managed.set(registration.id, { owner: registration.owner, runner: pi });
		state.registrations.set(registration.id, registration);
		try {
			notify(state);
		} catch (error) {
			state.managed.set(registration.id, current);
			if (previous === undefined) state.registrations.delete(registration.id);
			else state.registrations.set(registration.id, previous);
			throw error;
		}
		return;
	}
	if (state.registrations.has(registration.id))
		throw new Error(`Loadout tool id already registered: ${registration.id}`);
	pi.registerTool(tool);
	state.managed.set(registration.id, { owner: registration.owner, runner: pi });
	state.registrations.set(registration.id, registration);
	try {
		notify(state);
	} catch (error) {
		state.managed.delete(registration.id);
		state.registrations.delete(registration.id);
		throw error;
	}
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
	const previous = state.activation;
	state.activation = {
		knownIds: new Set(snapshot.knownIds),
		activeIds: new Set(snapshot.activeIds),
	};
	try {
		notifyActivation(state);
	} catch (error) {
		state.activation = previous;
		throw error;
	}
}

/** Clears a policy snapshot during lifecycle teardown. */
export function clearLoadoutToolActivation(pi: ExtensionAPI): void {
	const state = stateFor(pi);
	if (state.activation === undefined) return;
	const previous = state.activation;
	state.activation = undefined;
	try {
		notifyActivation(state);
	} catch (error) {
		state.activation = previous;
		throw error;
	}
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
