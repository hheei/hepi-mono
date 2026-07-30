import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGlobalState } from "./global-state.js";
import { runtimeIdentity } from "./runtime-identity.js";

declare const extensionPointKeyType: unique symbol;

/** Compile-time type marker for a stable, namespaced ExtensionPoint ID. */
export interface ExtensionPointKey<Hook> {
	readonly id: string;
	readonly [extensionPointKeyType]?: (value: Hook) => Hook;
}

export interface ExtensionPointHandle {
	/** Resolves after initial hook delivery; rejects when an owner callback fails. */
	readonly ready: Promise<void>;
	/** Removes this owner or hook registration generation. */
	dispose(): Promise<void>;
}

export interface OpenExtensionPointOptions<Hook> {
	/** Required cancellation boundary for dynamic hook delivery. */
	readonly signal: AbortSignal;
	readonly onAdd: (hook: Hook) => void | Promise<void>;
	readonly onRemove: (hook: Hook) => void | Promise<void>;
}

/** Creates a typed ExtensionPoint key without opening an owner registration. */
export function createExtensionPointKey<Hook>(_id: string): ExtensionPointKey<Hook> {
	if (!_id.trim()) throw new Error("ExtensionPoint id must not be empty");
	return { id: _id } as ExtensionPointKey<Hook>;
}

/** Opens the single owner registration and starts dynamic hook delivery. */
export function openExtensionPoint<Hook>(
	_pi: ExtensionAPI,
	_key: ExtensionPointKey<Hook>,
	_options: OpenExtensionPointOptions<Hook>,
): ExtensionPointHandle {
	const registry = getExtensionPointRegistry(_pi);
	if (registry.owners.has(_key.id))
		throw new Error(`ExtensionPoint owner already exists: ${_key.id}`);
	const owner: ExtensionPointOwner = {
		active: true,
		onAdd(hook: unknown): void | Promise<void> {
			return _options.onAdd(hook as Hook);
		},
		onRemove(hook: unknown): void | Promise<void> {
			return _options.onRemove(hook as Hook);
		},
		pending: Promise.resolve(),
	};
	registry.owners.set(_key.id, owner);
	const existing = registry.hooks.get(_key.id) ?? [];
	const ready = observeRejection(
		Promise.all(existing.map((registration) => deliverAdd(owner, registration))).then(
			() => undefined,
		),
	);
	const dispose = async (): Promise<void> => {
		if (!owner.active) return;
		owner.active = false;
		if (registry.owners.get(_key.id) === owner) registry.owners.delete(_key.id);
		for (const registration of registry.hooks.get(_key.id) ?? []) {
			if (registration.owner === owner) registration.owner = undefined;
		}
		_options.signal.removeEventListener("abort", onAbort);
	};
	const onAbort = (): void => {
		void dispose();
	};
	_options.signal.addEventListener("abort", onAbort, { once: true });
	if (_options.signal.aborted) onAbort();
	return { ready, dispose };
}

/** Registers a hook and returns its cleanup handle immediately. */
export function registerExtensionHook<Hook>(
	_pi: ExtensionAPI,
	_key: ExtensionPointKey<Hook>,
	_hook: Hook,
): ExtensionPointHandle {
	const registry = getExtensionPointRegistry(_pi);
	const registration: HookRegistration = { value: _hook, owner: undefined, active: true };
	const hooks = registry.hooks.get(_key.id) ?? [];
	hooks.push(registration);
	registry.hooks.set(_key.id, hooks);
	const owner = registry.owners.get(_key.id);
	const ready = observeRejection(
		owner === undefined ? Promise.resolve() : deliverAdd(owner, registration),
	);
	return {
		ready,
		async dispose(): Promise<void> {
			const currentHooks = registry.hooks.get(_key.id);
			if (currentHooks === undefined) return;
			const index = currentHooks.indexOf(registration);
			if (index === -1) return;
			registration.active = false;
			currentHooks.splice(index, 1);
			if (currentHooks.length === 0) registry.hooks.delete(_key.id);
			const deliveredOwner = registration.owner;
			registration.owner = undefined;
			if (deliveredOwner?.active)
				await enqueueOwnerCallback(deliveredOwner, () => deliveredOwner.onRemove(_hook));
		},
	};
}

interface ExtensionPointOwner {
	active: boolean;
	readonly onAdd: (hook: unknown) => void | Promise<void>;
	readonly onRemove: (hook: unknown) => void | Promise<void>;
	pending: Promise<void>;
}

interface HookRegistration {
	readonly value: unknown;
	owner: ExtensionPointOwner | undefined;
	active: boolean;
}

interface ExtensionPointRegistry {
	readonly owners: Map<string, ExtensionPointOwner>;
	readonly hooks: Map<string, HookRegistration[]>;
}

function getExtensionPointRegistry(pi: ExtensionAPI): ExtensionPointRegistry {
	const registries = getGlobalState(
		"extension-points",
		(): WeakMap<object, ExtensionPointRegistry> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const current = registries.get(identity);
	if (current !== undefined) return current;
	const created: ExtensionPointRegistry = { owners: new Map(), hooks: new Map() };
	registries.set(identity, created);
	return created;
}

function deliverAdd(owner: ExtensionPointOwner, registration: HookRegistration): Promise<void> {
	return enqueueOwnerCallback(owner, async () => {
		if (!owner.active || !registration.active) return;
		registration.owner = owner;
		await owner.onAdd(registration.value);
	});
}

function enqueueOwnerCallback(
	owner: ExtensionPointOwner,
	callback: () => void | Promise<void>,
): Promise<void> {
	const delivery = owner.pending.then(async () => {
		if (!owner.active) return;
		await callback();
	});
	owner.pending = delivery.then(
		() => undefined,
		() => undefined,
	);
	return delivery;
}

function observeRejection<T>(promise: Promise<T>): Promise<T> {
	void promise.catch(() => undefined);
	return promise;
}
