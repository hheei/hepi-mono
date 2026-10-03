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

export interface WaitForServiceOptions {
	/** Required cancellation boundary; the caller owns its timeout/deadline policy. */
	readonly signal: AbortSignal;
}

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

interface ServiceWaiter {
	readonly resolve: (value: unknown) => void;
	readonly abort: () => void;
}

interface ServiceRegistry {
	readonly services: Map<string, ServiceEntry>;
	readonly waiters: Map<string, Set<ServiceWaiter>>;
}

function createAbortError(): Error {
	return new Error("Service wait aborted");
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
	for (const waiter of registry.waiters.get(key.id) ?? []) waiter.resolve(entry.value);
	registry.waiters.delete(key.id);
	return true;
}

export function getService<T>(_pi: ExtensionAPI, _key: ServiceKey<T>): T | undefined {
	const registry = getServiceRegistry(_pi);
	const entry = registry.services.get(_key.id);
	return entry === undefined ? undefined : (entry.value as T);
}

export function waitForService<T>(
	_pi: ExtensionAPI,
	_key: ServiceKey<T>,
	_options: WaitForServiceOptions,
): Promise<T> {
	const registry = getServiceRegistry(_pi);
	const entry = registry.services.get(_key.id);
	if (entry !== undefined) return observeRejection(Promise.resolve(entry.value as T));
	const waiting = new Promise<T>((resolve, reject) => {
		if (_options.signal.aborted) {
			reject(createAbortError());
			return;
		}
		let onAbort: () => void = () => undefined;
		const removeWaiter = (): void => {
			_options.signal.removeEventListener("abort", onAbort);
			const waiters = registry.waiters.get(_key.id);
			if (waiters === undefined) return;
			waiters.delete(waiter);
			if (waiters.size === 0) registry.waiters.delete(_key.id);
		};
		const waiter: ServiceWaiter = {
			resolve(value: unknown): void {
				removeWaiter();
				resolve(value as T);
			},
			abort(): void {
				onAbort();
			},
		};
		onAbort = (): void => {
			removeWaiter();
			reject(createAbortError());
		};
		_options.signal.addEventListener("abort", onAbort, { once: true });
		const waiters = registry.waiters.get(_key.id) ?? new Set<ServiceWaiter>();
		waiters.add(waiter);
		registry.waiters.set(_key.id, waiters);
	});
	return observeRejection(waiting);
}

function observeRejection<T>(promise: Promise<T>): Promise<T> {
	promise.catch(() => undefined);
	return promise;
}

export function abortServiceWaiters(_pi: ExtensionAPI): void {
	const registry = getServiceRegistry(_pi);
	for (const [keyId, waiters] of registry.waiters.entries()) {
		for (const waiter of waiters) waiter.abort();
		registry.waiters.delete(keyId);
	}
}

function getServiceRegistry(pi: ExtensionAPI): ServiceRegistry {
	const registries = getGlobalState(
		"services",
		(): WeakMap<object, ServiceRegistry> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const current = registries.get(identity);
	if (current !== undefined) return current;
	const created: ServiceRegistry = { services: new Map(), waiters: new Map() };
	registries.set(identity, created);
	return created;
}
