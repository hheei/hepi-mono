import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGlobalState } from "./global-state.js";
import {
	defaultPiSettingsPaths,
	readJsonSettingsRoot,
	updateJsonSettingsRoot,
} from "./json-settings.js";
import { runtimeIdentity } from "./runtime-identity.js";

export type SettingPrimitive = boolean | number | string;
export type SettingValue = SettingPrimitive | readonly string[] | null;
export type SettingsState = Record<string, Record<string, SettingValue>>;

export interface SettingsContext {
	/** Current Pi session identity supplied to provider callbacks; hosts must not fabricate it. */
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly cwd?: string;
	readonly [key: string]: unknown;
}

export type SettingType = "boolean" | "enum" | "text" | "number" | "path" | "list";

export interface SettingOption<T extends SettingPrimitive = SettingPrimitive> {
	readonly value: T;
	readonly label?: string;
	readonly description?: string;
}

export interface SettingTabCycle {
	readonly fieldId: string;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: SettingPrimitive;
	readonly options: readonly SettingOption[];
	readonly separator?: string;
}

export interface SettingField<T extends SettingValue = SettingValue> {
	readonly id: string;
	readonly label: string;
	readonly type: SettingType;
	readonly defaultValue: T;
	readonly description: string;
	readonly options?: readonly SettingOption[];
	readonly tabCycle?: SettingTabCycle;
	format?(value: T): string;
	formatDisplay?(value: T, relatedValue?: SettingPrimitive): string;
	formatDescription?(value: T, relatedValue?: SettingPrimitive): string;
	parse(draft: string): T;
	validate?(value: T): string | undefined;
	enabled?(state: SettingsState): boolean;
}

export interface SettingGroup {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly fields: readonly SettingField[];
}

export interface SettingChange {
	readonly groupId: string;
	readonly fieldId: string;
	readonly value: SettingValue;
	readonly previousValue?: SettingValue;
	readonly state: SettingsState;
}

/**
 * Persistence boundary for one settings provider. Loading and saving JSON is core's
 * responsibility; applying a loaded value to live feature state remains provider-owned.
 */
export interface SettingsStorage {
	load(context: SettingsContext): SettingsState | undefined | Promise<SettingsState | undefined>;
	validate?(state: SettingsState, context: SettingsContext): void | Promise<void>;
	save(state: SettingsState, context: SettingsContext): void | Promise<void>;
	close?(context: SettingsContext): void | Promise<void>;
}

/** Rendered by a settings-surface owner; core does not render panels. */
export interface SettingsPanel {
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
export interface SettingsProvider {
	readonly id: string;
	readonly title: string;
	readonly moduleName?: string;
	readonly origin?: string;
	readonly description?: string;
	readonly groups: readonly SettingGroup[];
	readonly panels?: readonly SettingsPanel[];
	readonly storage: SettingsStorage;
	onLoad?(state: SettingsState, context: SettingsContext): void | Promise<void>;
	onChange?(change: SettingChange, context: SettingsContext): void | Promise<void>;
	onClose?(state: SettingsState, context: SettingsContext): void | Promise<void>;
}

/** Runtime-scoped provider registry; it stores no settings values and renders no UI. */
export interface SettingsRegistry {
	register(provider: SettingsProvider): () => void;
	replace(provider: SettingsProvider): () => void;
	list(options?: { readonly includeEmpty?: boolean }): readonly SettingsProvider[];
	get(id: string): SettingsProvider | undefined;
}

export const SETTING_DESCRIPTION_MIN_LENGTH = 20;

function validateDescriptions(provider: SettingsProvider): void {
	for (const group of provider.groups) {
		for (const field of group.fields) {
			if (field.description.trim().length < SETTING_DESCRIPTION_MIN_LENGTH)
				throw new Error(
					`Setting ${provider.id}.${group.id}.${field.id} requires a detailed description of at least ${SETTING_DESCRIPTION_MIN_LENGTH} characters`,
				);
			const cycle = field.tabCycle;
			if (cycle !== undefined && cycle.description.trim().length < SETTING_DESCRIPTION_MIN_LENGTH)
				throw new Error(
					`Setting ${provider.id}.${group.id}.${cycle.fieldId} requires a detailed description of at least ${SETTING_DESCRIPTION_MIN_LENGTH} characters`,
				);
		}
	}
}

class RuntimeSettingsRegistry implements SettingsRegistry {
	readonly #providers = new Map<string, SettingsProvider>();
	readonly #tokens = new Map<string, symbol>();

	register(provider: SettingsProvider): () => void {
		validateDescriptions(provider);
		if (this.#providers.has(provider.id))
			throw new Error(`Settings provider id collision: ${provider.id}`);
		return this.set(provider);
	}

	replace(provider: SettingsProvider): () => void {
		validateDescriptions(provider);
		return this.set(provider);
	}

	list(options: { readonly includeEmpty?: boolean } = {}): readonly SettingsProvider[] {
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

	get(id: string): SettingsProvider | undefined {
		return this.#providers.get(id);
	}

	private set(provider: SettingsProvider): () => void {
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
export function getRuntimeSettingsRegistry(pi: ExtensionAPI): SettingsRegistry {
	const registries = getGlobalState(
		"settings-registries",
		(): WeakMap<object, SettingsRegistry> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const existing = registries.get(identity);
	if (existing !== undefined) return existing;
	const created = new RuntimeSettingsRegistry();
	registries.set(identity, created);
	return created;
}

export function registerSettings(
	provider: SettingsProvider,
	registry: SettingsRegistry,
): () => void {
	return registry.register(provider);
}

export interface JsonSectionSettingsStorageOptions {
	readonly path?: string;
	readonly section: string;
	readonly group: string;
}

/** Maps one provider group onto direct primitive fields in a root JSON section. */
export interface JsonFlatSectionSettingsStorageOptions {
	readonly path?: string;
	readonly section: string;
	readonly group: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSettingValue(value: unknown): value is SettingValue {
	return (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string" ||
		(Array.isArray(value) && value.every((item) => typeof item === "string"))
	);
}

/**
 * Atomic global JSON section storage shared by independently installed settings providers.
 * It preserves sibling root sections through core's path lock, but providers still own
 * schema validation and whether a saved value changes their live feature state.
 */
export function createJsonSectionSettingsStorage(
	options: JsonSectionSettingsStorageOptions,
): SettingsStorage {
	const resolvePath = (): string => options.path ?? defaultPiSettingsPaths().globalPath;
	return {
		async load(): Promise<SettingsState | undefined> {
			const path = resolvePath();
			const root = await readJsonSettingsRoot(path);
			const section = root[options.section];
			if (section !== undefined && !isRecord(section))
				throw new Error(`Expected ${options.section} to be an object in ${path}`);
			const group = section?.[options.group];
			if (!isRecord(group)) return undefined;
			return {
				[options.group]: Object.fromEntries(
					Object.entries(group).filter((entry): entry is [string, SettingValue] =>
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

/**
 * Atomic global JSON storage for a provider whose fields are direct keys in one
 * root section. Nested sibling groups are preserved; direct primitive keys belong
 * to this provider. The group remains an in-memory UI construct and is never written.
 */
export function createJsonFlatSectionSettingsStorage(
	options: JsonFlatSectionSettingsStorageOptions,
): SettingsStorage {
	const resolvePath = (): string => options.path ?? defaultPiSettingsPaths().globalPath;
	return {
		async load(): Promise<SettingsState | undefined> {
			const path = resolvePath();
			const root = await readJsonSettingsRoot(path);
			const section = root[options.section];
			if (section !== undefined && !isRecord(section))
				throw new Error(`Expected ${options.section} to be an object in ${path}`);
			if (!isRecord(section)) return undefined;
			return {
				[options.group]: Object.fromEntries(
					Object.entries(section).filter((entry): entry is [string, SettingValue] =>
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
					...Object.fromEntries(
						Object.entries(section ?? {}).filter(
							(entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
						),
					),
					...(state[options.group] ?? {}),
				};
			});
		},
	};
}
