import type { HePiCommandContext } from "./settings.js";

export type HePiMaybePromise<T> = T | Promise<T>;

export interface HePiModule {
	readonly id: string;
	readonly label: string;
	readonly icon?: string;
	readonly commands: readonly string[];
	readonly open: (args: string, ctx: HePiCommandContext) => HePiMaybePromise<void>;
}

export interface HePiModuleRegistry {
	register(module: HePiModule): void;
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

	list(): readonly HePiModule[] {
		return [...this.#modules.values()].sort(
			(a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
		);
	}

	get(id: string): HePiModule | undefined {
		return this.#modules.get(id);
	}
}

const defaultModuleRegistry = new ModuleRegistry();

export function createHePiModuleRegistry(): HePiModuleRegistry {
	return new ModuleRegistry();
}

export function registerHePiModule(
	module: HePiModule,
	registry: HePiModuleRegistry = defaultModuleRegistry,
): void {
	registry.register(module);
}

export function listHePiModules(
	registry: HePiModuleRegistry = defaultModuleRegistry,
): readonly HePiModule[] {
	return registry.list();
}

export function getHePiModule(
	id: string,
	registry: HePiModuleRegistry = defaultModuleRegistry,
): HePiModule | undefined {
	return registry.get(id);
}
