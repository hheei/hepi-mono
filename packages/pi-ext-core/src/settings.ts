import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGlobalState } from "./global-state.js";
import {
	defaultPiSettingsPaths,
	readJsonSettingsRoot,
	updateJsonSettingsRoot,
} from "./json-settings.js";
import { runtimeIdentity } from "./runtime-identity.js";

export type HepiSettingPrimitive = boolean | number | string;
export type HepiSettingValue = HepiSettingPrimitive | null;
export type HepiSettingsState = Record<string, Record<string, HepiSettingValue>>;

export interface HepiContext {
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly cwd?: string;
	readonly [key: string]: unknown;
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
	readonly separator?: string;
}

export interface HepiSettingField<T extends HepiSettingPrimitive = HepiSettingPrimitive> {
	readonly id: string;
	readonly label: string;
	readonly type: HepiSettingType;
	readonly defaultValue: T;
	readonly description: string;
	readonly options?: readonly HepiSettingOption<T>[];
	readonly tabCycle?: HepiSettingTabCycle;
	format?(value: T): string;
	formatDisplay?(value: T, relatedValue?: HepiSettingPrimitive): string;
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

/**
 * Persistence boundary for one settings provider. Loading and saving JSON is core's
 * responsibility; applying a loaded value to live feature state remains provider-owned.
 */
export interface HepiSettingsStorage {
	load(
		context: HepiContext,
	): HepiSettingsState | undefined | Promise<HepiSettingsState | undefined>;
	validate?(state: HepiSettingsState, context: HepiContext): void | Promise<void>;
	save(state: HepiSettingsState, context: HepiContext): void | Promise<void>;
	close?(context: HepiContext): void | Promise<void>;
}

/** Rendered by a settings-surface owner; core does not render panels. */
export interface HepiSettingsPanel {
	readonly id: string;
	readonly label?: string;
	render(width: number): readonly string[];
	handleInput?(input: string): boolean | undefined | Promise<boolean | undefined>;
	invalidate?(): void;
}

/**
 * Describes one package's settings without owning a settings UI. A future host invokes
 * the provider callbacks; extensions decide whether a change affects live state now or
 * only on the next session start/reload.
 */
export interface HepiSettingsProvider {
	readonly id: string;
	readonly title: string;
	readonly moduleName?: string;
	readonly origin?: string;
	readonly description?: string;
	readonly groups: readonly HepiSettingGroup[];
	readonly panels?: readonly HepiSettingsPanel[];
	readonly storage: HepiSettingsStorage;
	onLoad?(state: HepiSettingsState, context: HepiContext): void | Promise<void>;
	onChange?(change: HepiSettingChange, context: HepiContext): void | Promise<void>;
	onClose?(state: HepiSettingsState, context: HepiContext): void | Promise<void>;
}

/** Runtime-scoped provider registry; it stores no settings values and renders no UI. */
export interface HepiSettingsRegistry {
	register(provider: HepiSettingsProvider): () => void;
	replace(provider: HepiSettingsProvider): () => void;
	list(options?: { readonly includeEmpty?: boolean }): readonly HepiSettingsProvider[];
	get(id: string): HepiSettingsProvider | undefined;
}

export const HEPI_SETTING_DESCRIPTION_MIN_LENGTH = 20;

function validateDescriptions(provider: HepiSettingsProvider): void {
	for (const group of provider.groups) {
		for (const field of group.fields) {
			if (field.description.trim().length < HEPI_SETTING_DESCRIPTION_MIN_LENGTH)
				throw new Error(
					`HEPI setting ${provider.id}.${group.id}.${field.id} requires a detailed description of at least ${HEPI_SETTING_DESCRIPTION_MIN_LENGTH} characters`,
				);
			const cycle = field.tabCycle;
			if (
				cycle !== undefined &&
				cycle.description.trim().length < HEPI_SETTING_DESCRIPTION_MIN_LENGTH
			)
				throw new Error(
					`HEPI setting ${provider.id}.${group.id}.${cycle.fieldId} requires a detailed description of at least ${HEPI_SETTING_DESCRIPTION_MIN_LENGTH} characters`,
				);
		}
	}
}

class SettingsRegistry implements HepiSettingsRegistry {
	readonly #providers = new Map<string, HepiSettingsProvider>();
	readonly #tokens = new Map<string, symbol>();

	register(provider: HepiSettingsProvider): () => void {
		validateDescriptions(provider);
		if (this.#providers.has(provider.id))
			throw new Error(`HePi settings provider id collision: ${provider.id}`);
		return this.set(provider);
	}

	replace(provider: HepiSettingsProvider): () => void {
		validateDescriptions(provider);
		return this.set(provider);
	}

	list(options: { readonly includeEmpty?: boolean } = {}): readonly HepiSettingsProvider[] {
		return [...this.#providers.values()]
			.filter(
				(provider) =>
					options.includeEmpty === true ||
					provider.groups.some((group) => group.fields.length > 0) ||
					(provider.panels?.length ?? 0) > 0,
			)
			.sort(
				(left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
			);
	}

	get(id: string): HepiSettingsProvider | undefined {
		return this.#providers.get(id);
	}

	private set(provider: HepiSettingsProvider): () => void {
		const token = Symbol(provider.id);
		this.#providers.set(provider.id, provider);
		this.#tokens.set(provider.id, token);
		return () => {
			if (this.#tokens.get(provider.id) !== token) return;
			this.#tokens.delete(provider.id);
			this.#providers.delete(provider.id);
		};
	}
}

/** Runtime-scoped registry shared across independently evaluated extension packages. */
export function getHepiRuntimeSettingsRegistry(pi: ExtensionAPI): HepiSettingsRegistry {
	const registries = getGlobalState(
		"settings-registries",
		(): WeakMap<object, HepiSettingsRegistry> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const existing = registries.get(identity);
	if (existing !== undefined) return existing;
	const created = new SettingsRegistry();
	registries.set(identity, created);
	return created;
}

export function registerHepiSettings(
	provider: HepiSettingsProvider,
	registry: HepiSettingsRegistry,
): () => void {
	return registry.register(provider);
}

export interface JsonSectionSettingsStorageOptions {
	readonly path?: string;
	readonly section: string;
	readonly group: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSettingValue(value: unknown): value is HepiSettingValue {
	return (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	);
}

/** Atomic global JSON section storage shared by independently installed settings providers. */
export function createJsonSectionSettingsStorage(
	options: JsonSectionSettingsStorageOptions,
): HepiSettingsStorage {
	const resolvePath = (): string => options.path ?? defaultPiSettingsPaths().globalPath;
	return {
		async load(): Promise<HepiSettingsState | undefined> {
			const path = resolvePath();
			const root = await readJsonSettingsRoot(path);
			const section = root[options.section];
			if (section !== undefined && !isRecord(section))
				throw new Error(`Expected ${options.section} to be an object in ${path}`);
			const group = section?.[options.group];
			if (!isRecord(group)) return undefined;
			return {
				[options.group]: Object.fromEntries(
					Object.entries(group).filter((entry): entry is [string, HepiSettingValue] =>
						isSettingValue(entry[1]),
					),
				),
			};
		},
		async save(state): Promise<void> {
			const path = resolvePath();
			await updateJsonSettingsRoot(path, (root) => {
				const section = root[options.section];
				if (section !== undefined && !isRecord(section))
					throw new Error(`Expected ${options.section} to be an object in ${path}`);
				root[options.section] = {
					...(section ?? {}),
					[options.group]: { ...(state[options.group] ?? {}) },
				};
			});
		},
	};
}
