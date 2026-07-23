import type { HePiMaybePromise } from "./modules.js";
import type { HePiPanel } from "./panels.js";

export type HePiSettingPrimitive = boolean | number | string;
export type HePiSettingValue = HePiSettingPrimitive | null;
export type HePiSettingsState = Record<string, Record<string, HePiSettingValue>>;

export interface HePiContext {
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly cwd?: string;
	readonly [key: string]: unknown;
}

export interface HePiCommandContext extends HePiContext {
	readonly command?: string;
}

export type HePiSettingType = "boolean" | "enum" | "text" | "number" | "path";

export interface HePiSettingOption<T extends HePiSettingPrimitive = HePiSettingPrimitive> {
	readonly value: T;
	readonly label?: string;
	readonly description?: string;
}

export interface HePiSettingTabCycle {
	readonly fieldId: string;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: HePiSettingPrimitive;
	readonly options: readonly HePiSettingOption[];
}

export interface HePiSettingField<T extends HePiSettingPrimitive = HePiSettingPrimitive> {
	readonly id: string;
	readonly label: string;
	readonly type: HePiSettingType;
	readonly defaultValue: T;
	readonly description: string;
	readonly options?: readonly HePiSettingOption<T>[];
	/** A related persisted value cycled with Tab while this field is selected. */
	readonly tabCycle?: HePiSettingTabCycle;
	format?(value: T): string;
	parse(draft: string): T;
	validate?(value: T): string | undefined;
	enabled?(state: HePiSettingsState): boolean;
}

export interface HePiSettingGroup {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly fields: readonly HePiSettingField[];
}

export interface HePiSettingChange {
	readonly groupId: string;
	readonly fieldId: string;
	readonly value: HePiSettingValue;
	readonly previousValue?: HePiSettingValue;
	readonly state: HePiSettingsState;
}

export interface HePiSettingsStorage {
	load(ctx: HePiContext): HePiMaybePromise<HePiSettingsState | undefined>;
	/** Validate a final state without persisting it. */
	validate?(state: HePiSettingsState, ctx: HePiContext): HePiMaybePromise<void>;
	save(state: HePiSettingsState, ctx: HePiContext): HePiMaybePromise<void>;
	close?(ctx: HePiContext): HePiMaybePromise<void>;
}

export interface HePiJsonStorageBackend {
	load(ctx?: HePiContext): HePiMaybePromise<HePiSettingsState | undefined>;
	save(state: HePiSettingsState, ctx?: HePiContext): HePiMaybePromise<void>;
}

export interface HePiSettingsProvider {
	readonly id: string;
	readonly title: string;
	/** Stable package module name used to group Settings, such as pi-fix. */
	readonly moduleName?: string;
	/** Module identifier shown in Settings Description panel. */
	readonly origin?: string;
	readonly description?: string;
	readonly groups: readonly HePiSettingGroup[];
	readonly panels?: readonly HePiPanel[];
	readonly storage: HePiSettingsStorage;
	readonly onLoad?: (state: HePiSettingsState, ctx: HePiContext) => HePiMaybePromise<void>;
	readonly onChange?: (change: HePiSettingChange, ctx: HePiContext) => HePiMaybePromise<void>;
	readonly onClose?: (state: HePiSettingsState, ctx: HePiContext) => HePiMaybePromise<void>;
}

export interface HePiSettingsRegistry {
	register(provider: HePiSettingsProvider): void;
	replace(provider: HePiSettingsProvider): void;
	list(options?: { includeEmpty?: boolean }): readonly HePiSettingsProvider[];
	get(id: string): HePiSettingsProvider | undefined;
}

export const HEPI_SETTING_DESCRIPTION_MIN_LENGTH = 20;

function validateSettingDescriptions(provider: HePiSettingsProvider): void {
	for (const group of provider.groups) {
		for (const field of group.fields) {
			if (field.description.trim().length < HEPI_SETTING_DESCRIPTION_MIN_LENGTH)
				throw new Error(
					`HEPI setting ${provider.id}.${group.id}.${field.id} requires a detailed description of at least ${HEPI_SETTING_DESCRIPTION_MIN_LENGTH} characters`,
				);
			const tabCycle = field.tabCycle;
			if (
				tabCycle !== undefined &&
				tabCycle.description.trim().length < HEPI_SETTING_DESCRIPTION_MIN_LENGTH
			)
				throw new Error(
					`HEPI setting ${provider.id}.${group.id}.${tabCycle.fieldId} requires a detailed description of at least ${HEPI_SETTING_DESCRIPTION_MIN_LENGTH} characters`,
				);
		}
	}
}

class SettingsRegistry implements HePiSettingsRegistry {
	readonly #providers = new Map<string, HePiSettingsProvider>();

	register(provider: HePiSettingsProvider): void {
		validateSettingDescriptions(provider);
		if (this.#providers.has(provider.id)) {
			throw new Error(`HePi settings provider id collision: ${provider.id}`);
		}
		this.#providers.set(provider.id, provider);
	}

	replace(provider: HePiSettingsProvider): void {
		validateSettingDescriptions(provider);
		this.#providers.set(provider.id, provider);
	}

	list(options: { includeEmpty?: boolean } = {}): readonly HePiSettingsProvider[] {
		return [...this.#providers.values()]
			.filter(
				(provider) =>
					options.includeEmpty ||
					provider.groups.some((group) => group.fields.length > 0) ||
					(provider.panels?.length ?? 0) > 0,
			)
			.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
	}

	get(id: string): HePiSettingsProvider | undefined {
		return this.#providers.get(id);
	}
}

declare global {
	var __hepiDefaultSettingsRegistry: HePiSettingsRegistry | undefined;
}

function getDefaultSettingsRegistry(): HePiSettingsRegistry {
	const existing = globalThis.__hepiDefaultSettingsRegistry;
	if (existing !== undefined) return existing;
	const created = new SettingsRegistry();
	globalThis.__hepiDefaultSettingsRegistry = created;
	return created;
}

const defaultSettingsRegistry = getDefaultSettingsRegistry();

export function createHePiSettingsRegistry(): HePiSettingsRegistry {
	return new SettingsRegistry();
}

export function registerHePiSettings(
	provider: HePiSettingsProvider,
	registry: HePiSettingsRegistry = defaultSettingsRegistry,
): void {
	registry.register(provider);
}

export function registerHePiSettingsIfAbsent(
	provider: HePiSettingsProvider,
	registry: HePiSettingsRegistry = defaultSettingsRegistry,
): void {
	if (registry.get(provider.id) === undefined) registry.register(provider);
}

export function replaceHePiSettings(
	provider: HePiSettingsProvider,
	registry: HePiSettingsRegistry = defaultSettingsRegistry,
): void {
	registry.replace(provider);
}

export function listHePiSettings(
	registry: HePiSettingsRegistry = defaultSettingsRegistry,
	options?: { includeEmpty?: boolean },
): readonly HePiSettingsProvider[] {
	return registry.list(options);
}

export function getHePiSettings(
	id: string,
	registry: HePiSettingsRegistry = defaultSettingsRegistry,
): HePiSettingsProvider | undefined {
	return registry.get(id);
}

export function createGlobalJsonStorage(backend: HePiJsonStorageBackend): HePiSettingsStorage {
	return { load: (ctx) => backend.load(ctx), save: (state, ctx) => backend.save(state, ctx) };
}

export function createProjectJsonStorage(backend: HePiJsonStorageBackend): HePiSettingsStorage {
	return { load: (ctx) => backend.load(ctx), save: (state, ctx) => backend.save(state, ctx) };
}

export const createGlobalJsonSettingsStorage = createGlobalJsonStorage;
export const createProjectJsonSettingsStorage = createProjectJsonStorage;
export const createSessionBackedStorage = createSessionStorage;

export function createSessionStorage(): HePiSettingsStorage {
	const states = new Map<string, HePiSettingsState>();
	return {
		load: (ctx) => states.get(ctx.sessionId),
		save: (state, ctx) => {
			states.set(ctx.sessionId, state);
		},
	};
}
