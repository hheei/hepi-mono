import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionLifecycleContext } from "./lifecycle.js";

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

/** A lifecycle-bound declaration for a tool Pi already registers elsewhere. */
export interface LoadoutInventoryRegistration extends LoadoutToolMetadata {}

/**
 * A static HEPI tool declaration. Core owns the Pi registration transport so an
 * independently loaded contributor does not depend on pi-loadout load order.
 */
export interface ManagedLoadoutToolRegistration extends LoadoutToolMetadata {
	readonly tool: Parameters<ExtensionAPI["registerTool"]>[0];
}

export interface LoadoutInventoryObserver {
	readonly signal: AbortSignal;
	onChange(items: readonly LoadoutToolMetadata[]): void;
}

/** Registers an existing tool as a Loadout inventory item for this lifecycle. */
export function registerLoadoutInventory(
	_context: ExtensionLifecycleContext,
	_registration: LoadoutInventoryRegistration,
): void {
	throw new Error("@hheei/pi-ext-core Loadout inventory is not implemented");
}

/** Registers a HEPI-owned executable tool and its corresponding static inventory item. */
export function registerManagedLoadoutTool(
	_pi: ExtensionAPI,
	_registration: ManagedLoadoutToolRegistration,
): void {
	throw new Error("@hheei/pi-ext-core managed Loadout tool is not implemented");
}

/** Observes the current inventory and its lifecycle-bound dynamic registrations. */
export function observeLoadoutInventory(
	_pi: ExtensionAPI,
	_observer: LoadoutInventoryObserver,
): void {
	throw new Error("@hheei/pi-ext-core Loadout inventory observer is not implemented");
}
