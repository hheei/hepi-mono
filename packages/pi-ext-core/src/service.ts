import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DisposerRegistry } from "./disposer-registry.js";
import { getGlobalState } from "./global-state.js";
import { runtimeIdentity } from "./runtime-identity.js";

export interface MemoryCompactorService {
	createCompactionDraft(
		firstKeptEntryId: string | null,
	): { summary: string; firstKeptEntryId: string | null } | undefined;
}

export const MEMORY_COMPACTOR_SERVICE_KEY = createServiceKey<MemoryCompactorService>(
	"@hheei/pi-ext-memory:compactor",
);

/**
 * Service capability identifier. Package scopes are enforced through key identity;
 * consumers should export a typed ServiceKey from an extension package or internal module.
 */
export interface ServiceKey<T> {
	readonly id: string;
	readonly __type?: T;
}

export function createServiceKey<T>(id: string): ServiceKey<T> {
	return { id };
}

interface ServiceEntry {
	readonly value: unknown;
}

interface ServiceRegistry {
	readonly services: Map<string, ServiceEntry>;
}

export interface ExtensionLifecycleContext {
	readonly pi: ExtensionAPI;
	readonly signal: AbortSignal;
	readonly resources: DisposerRegistry;
}

export function provideService<T>(
	context: ExtensionLifecycleContext,
	key: ServiceKey<T>,
	value: T,
): boolean {
	const registry = getServiceRegistry(context.pi);
	if (registry.services.has(key.id)) return false;
	const entry: ServiceEntry = { value };
	context.resources.add(`service:${key.id}`, () => {
		if (registry.services.get(key.id) === entry) registry.services.delete(key.id);
	});
	registry.services.set(key.id, entry);
	return true;
}

export function getService<T>(_pi: ExtensionAPI, _key: ServiceKey<T>): T | undefined {
	const registry = getServiceRegistry(_pi);
	const entry = registry.services.get(_key.id);
	return entry === undefined ? undefined : (entry.value as T);
}

function getServiceRegistry(pi: ExtensionAPI): ServiceRegistry {
	const registries = getGlobalState(
		"services",
		(): WeakMap<object, ServiceRegistry> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const current = registries.get(identity);
	if (current !== undefined) return current;
	const created: ServiceRegistry = { services: new Map() };
	registries.set(identity, created);
	return created;
}
