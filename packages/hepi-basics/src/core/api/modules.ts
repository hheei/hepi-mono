import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type ExtensionRuntimeHost, extensionRuntimeIdentity } from "../runtime/identity.js";
import type { HePiCommandContext } from "./settings.js";

export type HePiMaybePromise<T> = T | Promise<T>;

export interface HePiModuleViewContext {
	readonly context: HePiCommandContext;
	readonly host: { requestRender(): void };
	readonly theme: Theme;
	readonly height: number;
}

export interface HePiModuleView {
	readonly component: Component;
	close?(): HePiMaybePromise<void>;
}

export interface HePiModule {
	readonly id: string;
	readonly label: string;
	readonly icon?: string;
	readonly commands: readonly string[];
	readonly open: (args: string, ctx: HePiCommandContext) => HePiMaybePromise<void>;
	readonly createShellView?: (options: HePiModuleViewContext) => HePiMaybePromise<HePiModuleView>;
}

export interface HePiModuleRegistry {
	register(module: HePiModule): () => void;
	replace(module: HePiModule): () => void;
	list(): readonly HePiModule[];
	get(id: string): HePiModule | undefined;
}

class ModuleRegistry implements HePiModuleRegistry {
	readonly #modules = new Map<string, HePiModule>();
	readonly #registrations = new Map<string, symbol>();

	register(module: HePiModule): () => void {
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

	replace(module: HePiModule): () => void {
		const registration = Symbol(module.id);
		this.#modules.set(module.id, module);
		this.#registrations.set(module.id, registration);
		return () => {
			if (this.#registrations.get(module.id) !== registration) return;
			this.#registrations.delete(module.id);
			this.#modules.delete(module.id);
		};
	}

	list(): readonly HePiModule[] {
		return [...this.#modules.values()].sort(
			(a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
		);
	}

	get(id: string): HePiModule | undefined {
		return this.#modules.get(id);
	}
}

declare global {
	var __hepiModuleRegistriesByRuntime: WeakMap<object, HePiModuleRegistry> | undefined;
}

export function getHePiRuntimeModuleRegistry(pi: ExtensionRuntimeHost): HePiModuleRegistry {
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

export function createHePiModuleRegistry(): HePiModuleRegistry {
	return new ModuleRegistry();
}

export function registerHePiModule(module: HePiModule, registry: HePiModuleRegistry): () => void {
	return registry.register(module);
}

export function replaceHePiModule(module: HePiModule, registry: HePiModuleRegistry): () => void {
	return registry.replace(module);
}

export function listHePiModules(registry: HePiModuleRegistry): readonly HePiModule[] {
	return registry.list();
}

export function getHePiModule(id: string, registry: HePiModuleRegistry): HePiModule | undefined {
	return registry.get(id);
}
