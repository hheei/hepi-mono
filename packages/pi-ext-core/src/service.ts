import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGlobalState } from "./global-state.js";
import type { ExtensionLifecycleContext } from "./lifecycle.js";
import { runtimeIdentity } from "./runtime-identity.js";

declare const serviceKeyType: unique symbol;

/** Compile-time type marker for a stable, namespaced Service ID. */
export interface ServiceKey<T> {
	readonly id: string;
	readonly [serviceKeyType]?: (value: T) => T;
}

export interface WaitForServiceOptions {
	/** Required cancellation boundary; the caller owns its timeout/deadline policy. */
	readonly signal: AbortSignal;
}

/** Creates a typed Service key without registering a runtime provider. */
export function createServiceKey<T>(_id: string): ServiceKey<T> {
	if (!_id.trim()) throw new Error("Service id must not be empty");
	return { id: _id } as ServiceKey<T>;
}

/**
 * Provides a Service for the current lifecycle. The first provider wins; later
 * providers return false and must not replace the active Service. The registration
 * is removed with the provider lifecycle and resolves current waiters once.
 */
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

/** Returns the active Service, or undefined when no provider is installed. */
export function getService<T>(_pi: ExtensionAPI, _key: ServiceKey<T>): T | undefined {
	const entry = getServiceRegistry(_pi).services.get(_key.id);
	return entry?.value as T | undefined;
}

/**
 * Waits for a Service until the caller's signal aborts. This is a continuation,
 * not a lifecycle dependency: consumers must not await it inside a serial
 * `session_start` handler when the provider may register later.
 */
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

export function abortServiceWaiters(pi: ExtensionAPI): void {
	// Lifecycle shutdown aborts unresolved waits so stale consumers cannot outlive
	// the provider runtime or retain promises across a Pi reload.
	const registry = getServiceRegistry(pi);
	const waiters = [...registry.waiters.values()].flatMap((current) => [...current]);
	for (const waiter of waiters) waiter.abort();
}

interface ServiceEntry {
	readonly value: unknown;
}

interface ServiceWaiter {
	resolve(value: unknown): void;
	abort(): void;
}

interface ServiceRegistry {
	readonly services: Map<string, ServiceEntry>;
	readonly waiters: Map<string, Set<ServiceWaiter>>;
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

function observeRejection<T>(promise: Promise<T>): Promise<T> {
	void promise.catch(() => undefined);
	return promise;
}

function createAbortError(): Error {
	return new Error("Service wait aborted");
}
