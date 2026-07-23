import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
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
	register(module: HePiModule): void;
	replace(module: HePiModule): void;
	list(): readonly HePiModule[];
	get(id: string): HePiModule | undefined;
}

class ModuleRegistry implements HePiModuleRegistry {
	readonly #modules = new Map<string, HePiModule>();

	register(module: HePiModule): void {
		if (this.#modules.has(module.id)) {
			throw new Error(`HePi module id collision: ${module.id}`);
		}
		this.#modules.set(module.id, module);
	}

	replace(module: HePiModule): void {
		this.#modules.set(module.id, module);
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
	var __hepiDefaultModuleRegistry: HePiModuleRegistry | undefined;
}

function getDefaultModuleRegistry(): HePiModuleRegistry {
	const existing = globalThis.__hepiDefaultModuleRegistry;
	if (existing !== undefined) return existing;
	const created = new ModuleRegistry();
	globalThis.__hepiDefaultModuleRegistry = created;
	return created;
}

export const defaultHePiModuleRegistry: HePiModuleRegistry = getDefaultModuleRegistry();

export function createHePiModuleRegistry(): HePiModuleRegistry {
	return new ModuleRegistry();
}

export function registerHePiModule(
	module: HePiModule,
	registry: HePiModuleRegistry = defaultHePiModuleRegistry,
): void {
	registry.register(module);
}

export function replaceHePiModule(
	module: HePiModule,
	registry: HePiModuleRegistry = defaultHePiModuleRegistry,
): void {
	registry.replace(module);
}

export function listHePiModules(
	registry: HePiModuleRegistry = defaultHePiModuleRegistry,
): readonly HePiModule[] {
	return registry.list();
}

export function getHePiModule(
	id: string,
	registry: HePiModuleRegistry = defaultHePiModuleRegistry,
): HePiModule | undefined {
	return registry.get(id);
}
