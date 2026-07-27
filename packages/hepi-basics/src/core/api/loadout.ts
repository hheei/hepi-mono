import { type ExtensionRuntimeHost, extensionRuntimeIdentity } from "../runtime/identity.js";

export interface HepiLoadoutGroup {
	/** Stable owner id. A group may be registered only once in one runtime. */
	readonly id: string;
	/** Label shown by Loadout. */
	readonly label: string;
	/** Tool names or stable Loadout keys to place in this group. */
	readonly items?: readonly string[];
}

export interface HepiLoadoutGroupRegistry {
	register(group: HepiLoadoutGroup): () => void;
	replace(group: HepiLoadoutGroup): () => void;
	list(): readonly HepiLoadoutGroup[];
	get(id: string): HepiLoadoutGroup | undefined;
}

class LoadoutGroupRegistry implements HepiLoadoutGroupRegistry {
	readonly #groups = new Map<string, HepiLoadoutGroup>();
	readonly #registrations = new Map<string, symbol>();

	register(group: HepiLoadoutGroup): () => void {
		validateGroup(group);
		if (this.#groups.has(group.id)) throw new Error(`HePi Loadout group id collision: ${group.id}`);
		return this.set(group);
	}

	replace(group: HepiLoadoutGroup): () => void {
		validateGroup(group);
		return this.set(group);
	}

	list(): readonly HepiLoadoutGroup[] {
		return [...this.#groups.values()].sort(
			(a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
		);
	}

	get(id: string): HepiLoadoutGroup | undefined {
		return this.#groups.get(id);
	}

	private set(group: HepiLoadoutGroup): () => void {
		const registration = Symbol(group.id);
		this.#groups.set(group.id, group);
		this.#registrations.set(group.id, registration);
		return () => {
			if (this.#registrations.get(group.id) !== registration) return;
			this.#registrations.delete(group.id);
			this.#groups.delete(group.id);
		};
	}
}

function validateGroup(group: HepiLoadoutGroup): void {
	if (!group.id.trim()) throw new Error("HePi Loadout group id must not be empty");
	if (!group.label.trim())
		throw new Error(`HePi Loadout group label must not be empty: ${group.id}`);
	for (const item of group.items ?? []) {
		if (!item.trim()) throw new Error(`HePi Loadout group item must not be empty: ${group.id}`);
	}
}

declare global {
	var __hepiLoadoutGroupRegistriesByRuntime: WeakMap<object, HepiLoadoutGroupRegistry> | undefined;
}

export function getHepiRuntimeLoadoutGroupRegistry(
	pi: ExtensionRuntimeHost,
): HepiLoadoutGroupRegistry {
	let registries = globalThis.__hepiLoadoutGroupRegistriesByRuntime;
	if (registries === undefined) {
		registries = new WeakMap();
		globalThis.__hepiLoadoutGroupRegistriesByRuntime = registries;
	}
	const identity = extensionRuntimeIdentity(pi);
	const existing = registries.get(identity);
	if (existing !== undefined) return existing;
	const created = new LoadoutGroupRegistry();
	registries.set(identity, created);
	return created;
}

export function createHepiLoadoutGroupRegistry(): HepiLoadoutGroupRegistry {
	return new LoadoutGroupRegistry();
}

export function registerHepiLoadoutGroup(
	group: HepiLoadoutGroup,
	registry: HepiLoadoutGroupRegistry,
): () => void {
	return registry.register(group);
}

/**
 * Register a factory-time group contribution and remove it with the host session.
 * Factory-time registration is intentional: Loadout may load its inventory before
 * another feature's session_start handler runs.
 */
export function registerHepiRuntimeLoadoutGroup(
	pi: ExtensionRuntimeHost & {
		on(event: "session_shutdown", handler: () => void): void;
	},
	group: HepiLoadoutGroup,
): () => void {
	const unregister = registerHepiLoadoutGroup(group, getHepiRuntimeLoadoutGroupRegistry(pi));
	pi.on("session_shutdown", unregister);
	return unregister;
}

export function replaceHepiLoadoutGroup(
	group: HepiLoadoutGroup,
	registry: HepiLoadoutGroupRegistry,
): () => void {
	return registry.replace(group);
}
