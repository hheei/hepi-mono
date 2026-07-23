import type {
	LoadoutInventory,
	LoadoutInventoryProvider,
	LoadoutInventoryValue,
} from "./inventory.js";
import {
	filterLoadoutItems,
	type LoadoutItem,
	type LoadoutKey,
	type LoadoutResolvedItem,
	type LoadoutScope,
	type LoadoutStatusMaps,
	loadoutLegacyKeys,
	loadoutPersistenceKey,
	reconcileLoadoutSelection,
	resolveLoadoutItems,
	toggleLoadoutState,
} from "./model.js";
import type { LoadoutStorage } from "./storage.js";

export type LoadoutRuntimeHandler = (items: readonly LoadoutResolvedItem[]) => Promise<void>;
export interface LoadoutRuntimeHandlers {
	readonly mcp?: LoadoutRuntimeHandler;
	readonly tool?: LoadoutRuntimeHandler;
	readonly skill?: LoadoutRuntimeHandler;
}
export interface LoadoutControllerState {
	readonly scope: LoadoutScope;
	readonly query: string;
	readonly selectedKey?: LoadoutKey | undefined;
	readonly scrollTop: number;
	readonly inventory: readonly LoadoutItem[];
	readonly resolved: readonly LoadoutResolvedItem[];
	readonly pendingKey?: LoadoutKey | undefined;
	readonly error?: string | undefined;
	readonly closed: boolean;
}
export interface LoadoutControllerOptions {
	readonly storage: LoadoutStorage;
	readonly inventory: LoadoutInventoryProvider;
	readonly runtime?: LoadoutRuntimeHandlers;
	readonly scope?: LoadoutScope;
}
function readable(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function copyMaps(maps: LoadoutStatusMaps): LoadoutStatusMaps {
	return { global: { ...maps.global }, project: { ...maps.project } };
}
function normalize(value: LoadoutInventoryValue): readonly LoadoutItem[] {
	const items: readonly LoadoutItem[] = "items" in value ? value.items : value;
	return [...new Map(items.map((item) => [item.key, item] as const)).values()];
}

export class LoadoutController {
	private scope: LoadoutScope;
	private query = "";
	private selectedKey: LoadoutKey | undefined;
	private scrollTop = 0;
	private inventory: readonly LoadoutItem[] = [];
	private resolved: readonly LoadoutResolvedItem[] = [];
	private maps: LoadoutStatusMaps = { global: {}, project: {} };
	private pendingKey: LoadoutKey | undefined;
	private error: string | undefined;
	private closed: boolean = false;
	private queue: Promise<void> = Promise.resolve();
	private readonly pending = new Set<Promise<void>>();
	constructor(private readonly options: LoadoutControllerOptions) {
		this.scope = options.scope ?? "global";
	}
	get state(): LoadoutControllerState {
		return {
			scope: this.scope,
			query: this.query,
			selectedKey: this.selectedKey,
			scrollTop: this.scrollTop,
			inventory: this.inventory,
			resolved: this.resolved,
			pendingKey: this.pendingKey,
			error: this.error,
			closed: this.closed,
		};
	}
	getState(): LoadoutControllerState {
		return this.state;
	}
	private visible(): readonly LoadoutItem[] {
		return filterLoadoutItems(this.inventory, this.query);
	}
	private recompute(previousItems = this.inventory, previousSelected = this.selectedKey): void {
		this.resolved = resolveLoadoutItems(this.inventory, this.scope, this.maps);
		this.selectedKey = reconcileLoadoutSelection(this.visible(), previousSelected, previousItems);
	}
	private ensureOpen(): void {
		if (this.closed) throw new Error("Loadout controller is closed");
	}
	private getInventory(): Promise<readonly LoadoutItem[]> {
		return Promise.resolve(this.options.inventory.load()).then(normalize);
	}
	private applyRuntime(): Promise<void> {
		const runtime = this.options.runtime;
		if (!runtime) return Promise.resolve();
		return Promise.all(
			(["mcp", "tool", "skill"] as const).map((kind) =>
				runtime[kind]?.(this.resolved.filter((item) => item.kind === kind)),
			),
		).then(() => undefined);
	}
	private track(operation: Promise<void>): Promise<void> {
		this.queue = operation.catch(() => undefined);
		this.pending.add(operation);
		return operation.finally(() => this.pending.delete(operation));
	}
	async load(): Promise<void> {
		this.ensureOpen();
		try {
			const [stored, inventory] = await Promise.all([
				this.options.storage.load(),
				this.getInventory(),
			]);
			this.maps = copyMaps(stored);
			this.inventory = inventory;
			this.recompute();
			await this.applyRuntime();
			this.error = undefined;
		} catch (error) {
			this.error = readable(error);
			throw error;
		}
	}
	setScope(scope: LoadoutScope): void {
		this.ensureOpen();
		this.scope = scope;
		this.recompute();
	}
	setQuery(query: string): void {
		this.ensureOpen();
		this.query = query;
		this.recompute();
	}
	setScrollTop(scrollTop: number): void {
		this.ensureOpen();
		this.scrollTop = Math.max(0, scrollTop);
	}
	moveSelection(delta: number): void {
		this.ensureOpen();
		const items = this.visible();
		if (!items.length) {
			this.selectedKey = undefined;
			return;
		}
		const index = Math.max(
			0,
			items.findIndex((item) => item.key === this.selectedKey),
		);
		this.selectedKey = items[(index + delta + items.length) % items.length]?.key;
	}
	select(key: LoadoutKey | undefined): void {
		this.ensureOpen();
		this.selectedKey = reconcileLoadoutSelection(this.visible(), key, this.inventory);
	}
	async toggleSelected(): Promise<void> {
		this.ensureOpen();
		if (this.pendingKey) return;
		const key = this.selectedKey;
		const resolved = key && this.resolved.find((candidate) => candidate.key === key);
		if (resolved?.lockedBy) return;
		const item = key && this.inventory.find((candidate) => candidate.key === key);
		if (!item || !key) return;
		const storageKey = loadoutPersistenceKey(item);
		const previousMaps = copyMaps(this.maps);
		const nextMaps = toggleLoadoutState(item, this.scope, this.maps);
		const value = nextMaps[this.scope][storageKey];
		const legacyKeys = loadoutLegacyKeys(previousMaps[this.scope], item);
		this.maps = nextMaps;
		this.recompute();
		this.pendingKey = key;
		const operation = this.queue
			.then(async () => {
				try {
					await this.options.storage.update(this.scope, storageKey, value, legacyKeys);
				} catch (error) {
					this.maps = previousMaps;
					this.recompute();
					this.error = readable(error);
					return;
				}
				try {
					await this.applyRuntime();
					this.error = undefined;
				} catch (error) {
					const original = readable(error);
					let rollbackError: string | undefined;
					try {
						await this.options.storage.update(
							this.scope,
							storageKey,
							previousMaps[this.scope][storageKey],
						);
						this.maps = copyMaps(previousMaps);
						this.recompute();
						await this.applyRuntime();
					} catch (rollback) {
						rollbackError = readable(rollback);
						try {
							this.maps = copyMaps(await this.options.storage.load());
							this.recompute();
							await this.applyRuntime();
						} catch (reload) {
							rollbackError += `; reload failed: ${readable(reload)}`;
						}
					}
					this.error = rollbackError ? `${original}; rollback failed: ${rollbackError}` : original;
				}
			})
			.finally(() => {
				if (this.pendingKey === key) this.pendingKey = undefined;
			});
		await this.track(operation);
	}
	async refresh(replacement?: LoadoutInventory | readonly LoadoutItem[]): Promise<void> {
		this.ensureOpen();
		const previousItems = this.inventory;
		const previousSelected = this.selectedKey;
		const operation = this.queue.then(async () => {
			try {
				const [stored, inventory] = await Promise.all([
					this.options.storage.load(),
					replacement === undefined ? this.getInventory() : Promise.resolve(normalize(replacement)),
				]);
				this.maps = copyMaps(stored);
				this.inventory = inventory;
				this.recompute(previousItems, previousSelected);
				await this.applyRuntime();
				this.error = undefined;
			} catch (error) {
				this.error = readable(error);
				throw error;
			}
		});
		await this.track(operation);
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.queue;
		await Promise.all([...this.pending].map((operation) => operation.catch(() => undefined)));
	}
}
export function createLoadoutController(options: LoadoutControllerOptions): LoadoutController {
	return new LoadoutController(options);
}
