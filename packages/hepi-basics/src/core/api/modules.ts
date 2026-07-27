import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type ExtensionRuntimeHost, extensionRuntimeIdentity } from "../runtime/identity.js";
import type { HepiCommandContext } from "./settings.js";

export type HepiMaybePromise<T> = T | Promise<T>;

export interface HepiModuleViewContext {
	readonly context: HepiCommandContext;
	readonly host: { requestRender(): void };
	readonly theme: Theme;
	readonly height: number;
}

export interface HepiModuleView {
	readonly component: Component;
	close?(): HepiMaybePromise<void>;
}

export interface HepiModule {
	readonly id: string;
	readonly label: string;
	readonly icon?: string;
	readonly commands: readonly string[];
	readonly open: (args: string, ctx: HepiCommandContext) => HepiMaybePromise<void>;
	readonly createShellView?: (options: HepiModuleViewContext) => HepiMaybePromise<HepiModuleView>;
}

export interface HepiModuleRegistry {
	register(module: HepiModule): () => void;
	replace(module: HepiModule): () => void;
	list(): readonly HepiModule[];
	get(id: string): HepiModule | undefined;
}

class ModuleRegistry implements HepiModuleRegistry {
	readonly #modules = new Map<string, HepiModule>();
	readonly #registrations = new Map<string, symbol>();

	register(module: HepiModule): () => void {
		if (this.#modules.has(module.id)) {
			throw new Error(`HePi module id collision: ${module.id}`);
		}
		const registration = Symbol(module.id);
		this.#modules.set(module.id, module);
		this.#registrations.set(module.id, registration);
		return () => {
			if (this.#registrations.get(module.id) !== registration) return;
			this.#registrations.delete(module.id);
			this.#modules.delete(module.id);
		};
	}

	replace(module: HepiModule): () => void {
		const registration = Symbol(module.id);
		this.#modules.set(module.id, module);
		this.#registrations.set(module.id, registration);
		return () => {
			if (this.#registrations.get(module.id) !== registration) return;
			this.#registrations.delete(module.id);
			this.#modules.delete(module.id);
		};
	}

	list(): readonly HepiModule[] {
		return [...this.#modules.values()].sort(
			(a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
		);
	}

	get(id: string): HepiModule | undefined {
		return this.#modules.get(id);
	}
}

declare global {
	var __hepiModuleRegistriesByRuntime: WeakMap<object, HepiModuleRegistry> | undefined;
}

export function getHepiRuntimeModuleRegistry(pi: ExtensionRuntimeHost): HepiModuleRegistry {
	let registries = globalThis.__hepiModuleRegistriesByRuntime;
	if (registries === undefined) {
		registries = new WeakMap();
		globalThis.__hepiModuleRegistriesByRuntime = registries;
	}
	const identity = extensionRuntimeIdentity(pi);
	const existing = registries.get(identity);
	if (existing !== undefined) return existing;
	const created = new ModuleRegistry();
	registries.set(identity, created);
	return created;
}

export function createHepiModuleRegistry(): HepiModuleRegistry {
	return new ModuleRegistry();
}

export function registerHepiModule(module: HepiModule, registry: HepiModuleRegistry): () => void {
	return registry.register(module);
}

export function replaceHepiModule(module: HepiModule, registry: HepiModuleRegistry): () => void {
	return registry.replace(module);
}

export function listHepiModules(registry: HepiModuleRegistry): readonly HepiModule[] {
	return registry.list();
}

export function getHepiModule(id: string, registry: HepiModuleRegistry): HepiModule | undefined {
	return registry.get(id);
}
