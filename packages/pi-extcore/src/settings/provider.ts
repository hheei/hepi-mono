import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionSettingsProvider,
	ExtensionSettingsSubpanel,
	SettingsStorageAdapter,
} from "./register.js";
import { createDefaultSettingsState, mergeSettingsState } from "./state.js";
import { createAgentExtensionSettingsStorage } from "./storage.js";
import type { SettingChange, SettingDescription, SettingGroup, SettingsState } from "./types.js";

const namespaceSeparator = "/";

export interface RegisteredSettingsProvider extends ExtensionSettingsProvider {
	generalGroups: readonly SettingGroup[];
	generalPanels: readonly ExtensionSettingsSubpanel[];
	groups: readonly SettingGroup[];
	panels: readonly ExtensionSettingsSubpanel[];
	storage: SettingsStorageAdapter;
}

export function normalizeSettingsProvider(
	provider: ExtensionSettingsProvider,
): RegisteredSettingsProvider {
	return {
		...provider,
		generalGroups: provider.generalGroups ?? [],
		generalPanels: provider.generalPanels ?? [],
		groups: provider.groups ?? [],
		panels: provider.panels ?? [],
		storage: provider.storage ?? createAgentExtensionSettingsStorage(provider.id),
	};
}

export function providerSettingGroups(provider: RegisteredSettingsProvider): SettingGroup[] {
	return [...provider.generalGroups, ...provider.groups];
}

export async function loadProviderState(
	provider: RegisteredSettingsProvider,
	ctx: ExtensionContext,
): Promise<SettingsState> {
	const savedState = await provider.storage.load(ctx);
	return mergeSettingsState(providerSettingGroups(provider), savedState);
}

export async function loadProviderStates(
	providers: readonly RegisteredSettingsProvider[],
	ctx: ExtensionContext,
): Promise<Map<string, SettingsState>> {
	const states = new Map<string, SettingsState>();
	for (const provider of providers) {
		states.set(provider.id, await loadProviderState(provider, ctx));
	}
	return states;
}

export function createGeneralPaneGroups(
	providers: readonly RegisteredSettingsProvider[],
): SettingGroup[] {
	return providers.flatMap((provider) =>
		namespaceSettingGroups(provider, provider.generalGroups, true),
	);
}

export function namespaceSettingGroups(
	provider: RegisteredSettingsProvider,
	groups: readonly SettingGroup[],
	includeProviderTitle: boolean,
): SettingGroup[] {
	return groups.map((group) => ({
		...group,
		id: namespaceGroupId(provider.id, group.id),
		title: includeProviderTitle ? `${provider.title} / ${group.title}` : group.title,
		description: mergeDescriptions(
			includeProviderTitle ? provider.description : undefined,
			group.description,
		),
	}));
}

export function createPaneState(
	providers: readonly RegisteredSettingsProvider[],
	providerStates: ReadonlyMap<string, SettingsState>,
	selectGroups: (provider: RegisteredSettingsProvider) => readonly SettingGroup[],
): SettingsState {
	const state: SettingsState = {};
	for (const provider of providers) {
		const providerState = createProviderState(provider, providerStates);
		for (const group of selectGroups(provider)) {
			state[namespaceGroupId(provider.id, group.id)] = providerState[group.id] ?? {};
		}
	}
	return state;
}

export function createProviderState(
	provider: RegisteredSettingsProvider,
	providerStates: ReadonlyMap<string, SettingsState>,
): SettingsState {
	return (
		providerStates.get(provider.id) ?? createDefaultSettingsState(providerSettingGroups(provider))
	);
}

export function routeProviderChange(
	providers: readonly RegisteredSettingsProvider[],
	providerStates: ReadonlyMap<string, SettingsState>,
	change: SettingChange,
): { provider: RegisteredSettingsProvider; change: SettingChange } | undefined {
	const { providerId, groupId } = splitNamespacedGroupId(change.groupId);
	const provider = providers.find((item) => item.id === providerId);
	if (!provider) {
		return undefined;
	}

	const currentState = createProviderState(provider, providerStates);
	const nextState: SettingsState = {
		...currentState,
		[groupId]: {
			...(currentState[groupId] ?? {}),
			[change.fieldId]: change.value,
		},
	};

	return {
		provider,
		change: {
			...change,
			groupId,
			state: nextState,
		},
	};
}

export function namespaceGroupId(providerId: string, groupId: string): string {
	return `${providerId}${namespaceSeparator}${groupId}`;
}

export function splitNamespacedGroupId(groupId: string): { providerId: string; groupId: string } {
	const index = groupId.indexOf(namespaceSeparator);
	if (index === -1) {
		return { providerId: "", groupId };
	}

	return {
		providerId: groupId.slice(0, index),
		groupId: groupId.slice(index + namespaceSeparator.length),
	};
}

function mergeDescriptions(
	first: string | undefined,
	second: SettingDescription | undefined,
): SettingDescription | undefined {
	if (!first) return second;
	if (!second) return first;
	if (typeof second === "string") return `${first} ${second}`;
	return (theme) => `${first} ${second(theme)}`;
}
