import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHepiRuntimeSettingsRegistry as getCoreRuntimeSettingsRegistry } from "@hheei/pi-ext-core";
import type { ExtensionRuntimeHost } from "../runtime/identity.js";
import type { HepiMaybePromise, HepiPanel } from "./panels.js";

export type HepiSettingPrimitive = boolean | number | string;
export type HepiSettingValue = HepiSettingPrimitive | null;
export type HepiSettingsState = Record<string, Record<string, HepiSettingValue>>;

export interface HepiContext {
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly cwd?: string;
	readonly [key: string]: unknown;
}

export interface HepiCommandContext extends HepiContext {
	readonly command?: string;
}

export type HepiSettingType = "boolean" | "enum" | "text" | "number" | "path";

export interface HepiSettingOption<T extends HepiSettingPrimitive = HepiSettingPrimitive> {
	readonly value: T;
	readonly label?: string;
	readonly description?: string;
}

export interface HepiSettingTabCycle {
	readonly fieldId: string;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: HepiSettingPrimitive;
	readonly options: readonly HepiSettingOption[];
	/** Separator used by the generic Settings value renderer. */
	readonly separator?: string;
}

export interface HepiSettingField<T extends HepiSettingPrimitive = HepiSettingPrimitive> {
	readonly id: string;
	readonly label: string;
	readonly type: HepiSettingType;
	readonly defaultValue: T;
	readonly description: string;
	readonly options?: readonly HepiSettingOption<T>[];
	/** A related persisted value cycled with Tab while this field is selected. */
	readonly tabCycle?: HepiSettingTabCycle;
	format?(value: T): string;
	/** Format the compact list value, optionally using a related tab-cycle value. */
	formatDisplay?(value: T, relatedValue?: HepiSettingPrimitive): string;
	/** Format the Description panel value, optionally using a related tab-cycle value. */
	formatDescription?(value: T, relatedValue?: HepiSettingPrimitive): string;
	parse(draft: string): T;
	validate?(value: T): string | undefined;
	enabled?(state: HepiSettingsState): boolean;
}

export interface HepiSettingGroup {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly fields: readonly HepiSettingField[];
}

export interface HepiSettingChange {
	readonly groupId: string;
	readonly fieldId: string;
	readonly value: HepiSettingValue;
	readonly previousValue?: HepiSettingValue;
	readonly state: HepiSettingsState;
}

export interface HepiSettingsStorage {
	load(ctx: HepiContext): HepiMaybePromise<HepiSettingsState | undefined>;
	/** Validate a final state without persisting it. */
	validate?(state: HepiSettingsState, ctx: HepiContext): HepiMaybePromise<void>;
	save(state: HepiSettingsState, ctx: HepiContext): HepiMaybePromise<void>;
	close?(ctx: HepiContext): HepiMaybePromise<void>;
}

export interface HepiJsonStorageBackend {
	load(ctx?: HepiContext): HepiMaybePromise<HepiSettingsState | undefined>;
	save(state: HepiSettingsState, ctx?: HepiContext): HepiMaybePromise<void>;
}

export interface HepiSettingsProvider {
	readonly id: string;
	readonly title: string;
	/** Stable package module name used to group Settings, such as pi-fix. */
	readonly moduleName?: string;
	/** Module identifier shown in Settings Description panel. */
	readonly origin?: string;
	readonly description?: string;
	readonly groups: readonly HepiSettingGroup[];
	readonly panels?: readonly HepiPanel[];
	readonly storage: HepiSettingsStorage;
	readonly onLoad?: (state: HepiSettingsState, ctx: HepiContext) => HepiMaybePromise<void>;
	readonly onChange?: (change: HepiSettingChange, ctx: HepiContext) => HepiMaybePromise<void>;
	readonly onClose?: (state: HepiSettingsState, ctx: HepiContext) => HepiMaybePromise<void>;
}

export interface HepiSettingsRegistry {
	register(provider: HepiSettingsProvider): () => void;
	replace(provider: HepiSettingsProvider): () => void;
	list(options?: { includeEmpty?: boolean }): readonly HepiSettingsProvider[];
	get(id: string): HepiSettingsProvider | undefined;
}

export const HEPI_SETTING_DESCRIPTION_MIN_LENGTH = 20;

function validateSettingDescriptions(provider: HepiSettingsProvider): void {
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

class SettingsRegistry implements HepiSettingsRegistry {
	readonly #providers = new Map<string, HepiSettingsProvider>();
	readonly #registrations = new Map<string, symbol>();

	register(provider: HepiSettingsProvider): () => void {
		validateSettingDescriptions(provider);
		if (this.#providers.has(provider.id)) {
			throw new Error(`HePi settings provider id collision: ${provider.id}`);
		}
		return this.set(provider);
	}

	replace(provider: HepiSettingsProvider): () => void {
		validateSettingDescriptions(provider);
		return this.set(provider);
	}

	list(options: { includeEmpty?: boolean } = {}): readonly HepiSettingsProvider[] {
		return [...this.#providers.values()]
			.filter(
				(provider) =>
					options.includeEmpty ||
					provider.groups.some((group) => group.fields.length > 0) ||
					(provider.panels?.length ?? 0) > 0,
			)
			.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
	}

	get(id: string): HepiSettingsProvider | undefined {
		return this.#providers.get(id);
	}

	private set(provider: HepiSettingsProvider): () => void {
		const registration = Symbol(provider.id);
		this.#providers.set(provider.id, provider);
		this.#registrations.set(provider.id, registration);
		return () => {
			if (this.#registrations.get(provider.id) !== registration) return;
			this.#registrations.delete(provider.id);
			this.#providers.delete(provider.id);
		};
	}
}

declare global {
	var __hepiSettingsRegistriesByRuntime: WeakMap<object, HepiSettingsRegistry> | undefined;
}

export function getHepiRuntimeSettingsRegistry(pi: ExtensionRuntimeHost): HepiSettingsRegistry {
	// Transitional facade: old Basics providers and independent core consumers
	// must register into one runtime-scoped Settings surface.
	return getCoreRuntimeSettingsRegistry(pi as ExtensionAPI) as unknown as HepiSettingsRegistry;
}

export function createHepiSettingsRegistry(): HepiSettingsRegistry {
	return new SettingsRegistry();
}

export function registerHepiSettings(
	provider: HepiSettingsProvider,
	registry: HepiSettingsRegistry,
): () => void {
	return registry.register(provider);
}

export function registerHepiSettingsIfAbsent(
	provider: HepiSettingsProvider,
	registry: HepiSettingsRegistry,
): void {
	if (registry.get(provider.id) === undefined) registry.register(provider);
}

export function replaceHepiSettings(
	provider: HepiSettingsProvider,
	registry: HepiSettingsRegistry,
): () => void {
	return registry.replace(provider);
}

export function listHepiSettings(
	registry: HepiSettingsRegistry,
	options?: { includeEmpty?: boolean },
): readonly HepiSettingsProvider[] {
	return registry.list(options);
}

export function getHepiSettings(
	id: string,
	registry: HepiSettingsRegistry,
): HepiSettingsProvider | undefined {
	return registry.get(id);
}

export function createGlobalJsonStorage(backend: HepiJsonStorageBackend): HepiSettingsStorage {
	return { load: (ctx) => backend.load(ctx), save: (state, ctx) => backend.save(state, ctx) };
}

export function createProjectJsonStorage(backend: HepiJsonStorageBackend): HepiSettingsStorage {
	return { load: (ctx) => backend.load(ctx), save: (state, ctx) => backend.save(state, ctx) };
}

export const createGlobalJsonSettingsStorage = createGlobalJsonStorage;
export const createProjectJsonSettingsStorage = createProjectJsonStorage;
export const createSessionBackedStorage = createSessionStorage;

export function createSessionStorage(): HepiSettingsStorage {
	const states = new Map<string, HepiSettingsState>();
	return {
		load: (ctx) => states.get(ctx.sessionId),
		save: (state, ctx) => {
			states.set(ctx.sessionId, state);
		},
	};
}
