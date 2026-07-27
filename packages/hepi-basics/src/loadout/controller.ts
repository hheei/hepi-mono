import type {
	LoadoutInventory,
	LoadoutInventoryProvider,
	LoadoutInventoryValue,
} from "./inventory.js";
import {
	filterLoadoutItemsForView,
	type LoadoutItem,
	type LoadoutKey,
	type LoadoutResolvedItem,
	type LoadoutScope,
	type LoadoutStatusMaps,
	type LoadoutView,
	loadoutPersistenceKey,
	reconcileLoadoutSelection,
	resolveLoadoutItems,
	toggleLoadoutState,
} from "./model.js";
import type { LoadoutStorage } from "./storage.js";

export type LoadoutRuntimeHandler = (
	items: readonly LoadoutResolvedItem[],
	signal?: AbortSignal,
) => Promise<void>;
export interface LoadoutRuntimeHandlers {
	readonly mcp?: LoadoutRuntimeHandler;
	readonly tool?: LoadoutRuntimeHandler;
	readonly skill?: LoadoutRuntimeHandler;
}
export interface LoadoutControllerState {
	readonly scope: LoadoutScope;
	readonly view: LoadoutView;
	readonly query: string;
	readonly selectedKey?: LoadoutKey | undefined;
	readonly scrollTop: number;
	readonly inventory: readonly LoadoutItem[];
	readonly visible: readonly LoadoutItem[];
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
	readonly view?: LoadoutView;
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
	private readonly options: LoadoutControllerOptions;
	private scope: LoadoutScope;
	private view: LoadoutView;
	private query = "";
	private selectedKey: LoadoutKey | undefined;
	private scrollTop = 0;
	private inventory: readonly LoadoutItem[] = [];
	private visibleItems: readonly LoadoutItem[] = [];
	private resolved: readonly LoadoutResolvedItem[] = [];
	private maps: LoadoutStatusMaps = { global: {}, project: {} };
	private pendingKey: LoadoutKey | undefined;
	private error: string | undefined;
	private closed: boolean = false;
	private queue: Promise<void> = Promise.resolve();
	private readonly pending = new Set<Promise<void>>();
	private readonly abortController = new AbortController();
	constructor(options: LoadoutControllerOptions) {
		this.options = options;
		this.scope = options.scope ?? "global";
		this.view = options.view ?? "tools";
	}
	get state(): LoadoutControllerState {
		return {
			scope: this.scope,
			view: this.view,
			query: this.query,
			selectedKey: this.selectedKey,
			scrollTop: this.scrollTop,
			inventory: this.inventory,
			visible: this.visibleItems,
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
		return this.visibleItems;
	}
	private recompute(
		previousItems = this.inventory,
		previousSelected = this.selectedKey,
		resolveStatuses = true,
	): void {
		if (resolveStatuses) this.resolved = resolveLoadoutItems(this.inventory, this.scope, this.maps);
		this.visibleItems = filterLoadoutItemsForView(this.inventory, this.view, this.query);
		this.selectedKey = reconcileLoadoutSelection(this.visible(), previousSelected, previousItems);
	}
	private ensureOpen(): void {
		if (this.closed) throw new Error("Loadout controller is closed");
	}
	private getInventory(): Promise<readonly LoadoutItem[]> {
		const signal = this.abortController.signal;
		return Promise.resolve(this.options.inventory.load(signal)).then((value) => {
			signal.throwIfAborted();
			return normalize(value);
		});
	}
	private applyRuntime(): Promise<void> {
		const runtime = this.options.runtime;
		if (!runtime) return Promise.resolve();
		const signal = this.abortController.signal;
		signal.throwIfAborted();
		return Promise.all(
			(["mcp", "tool", "skill"] as const).map((kind) =>
				runtime[kind]?.(
					this.resolved.filter((item) => item.kind === kind),
					signal,
				),
			),
		).then(() => signal.throwIfAborted());
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
				this.options.storage.load(this.abortController.signal),
				this.getInventory(),
			]);
			this.abortController.signal.throwIfAborted();
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
	setView(view: LoadoutView): void {
		this.ensureOpen();
		this.view = view;
		this.recompute(this.inventory, this.selectedKey, false);
	}
	setQuery(query: string): void {
		this.ensureOpen();
		this.query = query;
		this.recompute(this.inventory, this.selectedKey, false);
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
		this.selectedKey = items[Math.min(items.length - 1, Math.max(0, index + delta))]?.key;
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
		this.maps = nextMaps;
		this.recompute();
		this.pendingKey = key;
		const operation = this.queue
			.then(async () => {
				try {
					await this.options.storage.update(
						this.scope,
						storageKey,
						value,
						this.abortController.signal,
					);
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
							this.abortController.signal,
						);
						this.maps = copyMaps(previousMaps);
						this.recompute();
						await this.applyRuntime();
					} catch (rollback) {
						rollbackError = readable(rollback);
						try {
							this.maps = copyMaps(await this.options.storage.load(this.abortController.signal));
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
					this.options.storage.load(this.abortController.signal),
					replacement === undefined ? this.getInventory() : Promise.resolve(normalize(replacement)),
				]);
				this.abortController.signal.throwIfAborted();
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
		this.abortController.abort();
		await this.queue;
		await Promise.all([...this.pending].map((operation) => operation.catch(() => undefined)));
	}
}
export function createLoadoutController(options: LoadoutControllerOptions): LoadoutController {
	return new LoadoutController(options);
}
