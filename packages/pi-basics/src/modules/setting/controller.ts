import type {
	HePiContext,
	HePiSettingField,
	HePiSettingsProvider,
	HePiSettingsRegistry,
	HePiSettingsState,
	HePiSettingValue,
} from "../../api/settings.js";
import { cycleOption, mergeSettingsState, SettingsModel, visibleFields } from "./model.js";

export interface SettingsControllerOptions {
	readonly providers?: readonly HePiSettingsProvider[];
	readonly registry?: HePiSettingsRegistry;
	readonly context: HePiContext;
}

function readableError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function cloneState(state: HePiSettingsState): HePiSettingsState {
	return Object.fromEntries(Object.entries(state).map(([g, values]) => [g, { ...values }]));
}
interface PendingChange {
	readonly groupId: string;
	readonly fieldId: string;
	readonly value: HePiSettingValue;
}
function applyChange(state: HePiSettingsState, change: PendingChange): HePiSettingsState {
	const next = cloneState(state);
	next[change.groupId] = { ...(next[change.groupId] ?? {}), [change.fieldId]: change.value };
	return next;
}
function applyChanges(
	state: HePiSettingsState,
	changes: readonly PendingChange[],
): HePiSettingsState {
	return changes.reduce(applyChange, state);
}
function changedValues(
	previous: HePiSettingsState,
	next: HePiSettingsState,
): readonly PendingChange[] {
	return Object.entries(next).flatMap(([groupId, values]) =>
		Object.entries(values).flatMap(([fieldId, value]) =>
			Object.is(previous[groupId]?.[fieldId], value) ? [] : [{ groupId, fieldId, value }],
		),
	);
}

export class SettingsController {
	readonly model: SettingsModel;
	readonly context: HePiContext;
	readonly #committed = new Map<string, HePiSettingsState>();
	readonly #dirty = new Set<string>();
	#closed: boolean = false;
	#loading: boolean = false;
	#loadGeneration = 0;
	#activeLoad: Promise<void> | undefined;

	constructor(options: SettingsControllerOptions) {
		const providers = (options.providers ?? options.registry?.list() ?? []).filter(
			(provider) =>
				provider.groups.some((group) => group.fields.length > 0) ||
				(provider.panels?.length ?? 0) > 0,
		);
		this.context = options.context;
		this.model = new SettingsModel(providers);
	}
	get state() {
		return this.model.state;
	}
	get provider(): HePiSettingsProvider | undefined {
		return this.model.active?.provider;
	}
	get loading(): boolean {
		return this.#loading;
	}

	private async loadProviders(generation: number): Promise<void> {
		for (const snapshot of this.model.state.providers) {
			const stored = await snapshot.provider.storage.load(this.context);
			if (this.#closed || generation !== this.#loadGeneration) return;
			const merged = mergeSettingsState(snapshot.provider, stored);
			this.#committed.set(snapshot.provider.id, cloneState(merged));
			this.model.setCommitted(snapshot.provider.id, merged);
			await snapshot.provider.onLoad?.(cloneState(merged), this.context);
			if (this.#closed || generation !== this.#loadGeneration) return;
		}
	}

	load(): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("Settings controller is closed"));
		const generation = ++this.#loadGeneration;
		this.#loading = true;
		const operation = this.loadProviders(generation);
		this.#activeLoad = operation;
		return operation.finally(() => {
			if (this.#activeLoad === operation) {
				this.#activeLoad = undefined;
				this.#loading = false;
			}
		});
	}
	select(itemId: string): void {
		this.model.select(itemId);
	}

	fields() {
		return visibleFields(this.model.active, this.state.search, this.state.collapsedGroupIds);
	}
	selectProvider(providerId: string): void {
		this.model.setProvider(providerId);
	}
	setSearch(query: string): void {
		this.model.setSearch(query);
	}
	toggleGroup(groupId: string): void {
		this.model.toggleGroup(groupId);
	}
	setScrollTop(scrollTop: number): void {
		this.model.state = { ...this.state, scrollTop: Math.max(0, scrollTop) };
	}

	private field(fieldId?: string): HePiSettingField & { readonly groupId: string } {
		const selected = this.model.selectedField;
		const field =
			fieldId === undefined
				? selected
				: selected?.id === fieldId
					? selected
					: this.model.active?.fields.find((candidate) => candidate.id === fieldId);
		if (!field) throw new Error("No setting selected");
		return field;
	}
	private currentValue(field: HePiSettingField & { readonly groupId: string }): HePiSettingValue {
		return (
			this.state.committed[this.provider?.id ?? ""]?.[field.groupId]?.[field.id] ??
			field.defaultValue
		);
	}
	private updateOptimistic(
		provider: HePiSettingsProvider,
		groupId: string,
		fieldId: string,
		value: HePiSettingValue,
	): void {
		this.model.setCommitted(
			provider.id,
			applyChange(this.state.committed[provider.id] ?? {}, { groupId, fieldId, value }),
		);
		this.#dirty.add(provider.id);
	}

	async change(value: HePiSettingValue, fieldId?: string): Promise<void> {
		const provider = this.provider;
		if (!provider) throw new Error("No settings provider selected");
		if (this.#closed) throw new Error("Settings controller is closed");
		if (this.#loading) throw new Error("Settings are still loading");
		const field = this.field(fieldId);
		if (field.options && !field.options.some((option) => Object.is(option.value, value)))
			throw new Error(`Invalid option for setting: ${field.id}`);
		this.updateOptimistic(provider, field.groupId, field.id, value);
	}
	async toggle(fieldId?: string): Promise<void> {
		const field = this.field(fieldId);
		if (field.type !== "boolean") throw new Error(`Setting is not boolean: ${field.id}`);
		await this.change(!this.currentValue(field), field.id);
	}
	async cycle(fieldId?: string, direction = 1): Promise<void> {
		const field = this.field(fieldId);
		await this.change(
			cycleOption(
				field as HePiSettingField<boolean | number | string>,
				this.currentValue(field) as boolean | number | string,
				direction,
			),
			field.id,
		);
	}
	async cycleTab(fieldId?: string, direction = 1): Promise<void> {
		const field = this.field(fieldId);
		const tabCycle = field.tabCycle;
		if (!tabCycle) throw new Error(`Setting has no Tab cycle: ${field.id}`);
		const providerId = this.provider?.id ?? "";
		const current = this.state.committed[providerId]?.[field.groupId]?.[tabCycle.fieldId];
		const cycleField: HePiSettingField = {
			...field,
			id: tabCycle.fieldId,
			options: tabCycle.options,
		};
		const value = cycleOption(cycleField, current ?? tabCycle.defaultValue, direction);
		const provider = this.provider;
		if (!provider) throw new Error("No settings provider selected");
		this.updateOptimistic(provider, field.groupId, tabCycle.fieldId, value);
	}
	beginEdit(fieldId?: string): void {
		const field = this.field(fieldId);
		const value = this.currentValue(field);
		const tabCycle = field.tabCycle;
		const relatedValue = tabCycle
			? (this.state.committed[this.provider?.id ?? ""]?.[field.groupId]?.[tabCycle.fieldId] ??
				tabCycle.defaultValue)
			: undefined;
		this.model.beginEdit(value === null ? "" : String(value), relatedValue);
	}
	setDraft(draft: string): void {
		if (this.state.mode !== "Edit") throw new Error("Not editing a setting");
		this.model.setDraftValue(draft);
	}
	cycleDraft(direction = 1): void {
		if (this.state.mode !== "Edit") throw new Error("Not editing a setting");
		const field = this.field() as HePiSettingField<boolean | number | string> & {
			readonly groupId: string;
		};
		const current = field.parse(this.state.draftValue ?? "");
		this.model.setDraftValue(String(cycleOption(field, current, direction)));
	}
	cycleTabDraft(direction = 1): void {
		if (this.state.mode !== "Edit") throw new Error("Not editing a setting");
		const field = this.field();
		const tabCycle = field.tabCycle;
		if (!tabCycle) throw new Error(`Setting has no Tab cycle: ${field.id}`);
		const cycleField: HePiSettingField = {
			...field,
			id: tabCycle.fieldId,
			options: tabCycle.options,
		};
		const current = this.state.draftRelatedValue ?? tabCycle.defaultValue;
		this.model.setDraftRelatedValue(
			cycleOption(cycleField, current as boolean | number | string, direction),
		);
	}
	async commitEdit(): Promise<void> {
		if (this.state.mode !== "Edit") throw new Error("Not editing a setting");
		const field = this.field();
		let value: HePiSettingValue;
		let changes: readonly [PendingChange, ...PendingChange[]];
		try {
			value = field.parse(this.state.draftValue ?? "");
			if (typeof value === "number" && Number.isNaN(value))
				throw new Error("Setting value must not be NaN");
			if (field.options && !field.options.some((option) => Object.is(option.value, value)))
				throw new Error(`Invalid option for setting: ${field.id}`);
			const validation = field.validate?.(value as never);
			if (validation) throw new Error(validation);
			const primary: PendingChange = { groupId: field.groupId, fieldId: field.id, value };
			const tabCycle = field.tabCycle;
			if (!tabCycle) changes = [primary];
			else {
				const related = this.state.draftRelatedValue ?? tabCycle.defaultValue;
				if (!tabCycle.options.some((option) => Object.is(option.value, related)))
					throw new Error(`Invalid option for setting: ${tabCycle.fieldId}`);
				changes = [primary, { groupId: field.groupId, fieldId: tabCycle.fieldId, value: related }];
			}
		} catch (error) {
			this.model.setError(readableError(error));
			throw error;
		}
		const provider = this.provider;
		if (!provider) throw new Error("No settings provider selected");
		const next = applyChanges(this.state.committed[provider.id] ?? {}, changes);
		try {
			await provider.storage.validate?.(cloneState(next), this.context);
		} catch (error) {
			this.model.setError(readableError(error));
			throw error;
		}
		for (const change of changes)
			this.updateOptimistic(provider, change.groupId, change.fieldId, change.value);
		this.model.cancelEdit();
	}
	cancelEdit(): void {
		this.model.cancelEdit();
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#loadGeneration++;
		await Promise.allSettled([this.#activeLoad].filter(Boolean));
		const cleanups = this.state.providers.map(async (snapshot) => {
			const failures: Array<{ readonly providerId: string; readonly error: unknown }> = [];
			const provider = snapshot.provider;
			const state = cloneState(this.state.committed[provider.id] ?? {});
			const previous = cloneState(this.#committed.get(provider.id) ?? {});
			const changes = changedValues(previous, state);
			if (this.#dirty.has(provider.id) && changes.length > 0) {
				try {
					await provider.storage.validate?.(cloneState(state), this.context);
					for (const change of changes) {
						const previousValue = previous[change.groupId]?.[change.fieldId];
						await provider.onChange?.(
							{
								...change,
								...(previousValue === undefined ? {} : { previousValue }),
								state: cloneState(state),
							},
							this.context,
						);
					}
					await provider.storage.save(cloneState(state), this.context);
					this.#committed.set(provider.id, cloneState(state));
					this.#dirty.delete(provider.id);
				} catch (error) {
					this.model.setError(readableError(error));
					failures.push({ providerId: provider.id, error });
				}
			}
			const onClose = await Promise.allSettled([
				Promise.resolve().then(() => provider.onClose?.(state, this.context)),
			]);
			if (onClose[0]?.status === "rejected")
				failures.push({ providerId: provider.id, error: onClose[0].reason });
			const storageClose = await Promise.allSettled([
				Promise.resolve().then(() => provider.storage.close?.(this.context)),
			]);
			if (storageClose[0]?.status === "rejected")
				failures.push({ providerId: provider.id, error: storageClose[0].reason });
			return failures;
		});
		const settled = await Promise.allSettled(cleanups);
		const failures = settled.flatMap((result) =>
			result.status === "fulfilled"
				? result.value
				: [{ providerId: "settings", error: result.reason }],
		);
		this.#dirty.clear();
		this.model.cancelEdit();
		if (failures.length > 0)
			throw new AggregateError(
				failures.map((failure) => failure.error),
				"Settings cleanup failed",
			);
	}
}

export function createSettingsController(options: SettingsControllerOptions): SettingsController {
	return new SettingsController(options);
}
