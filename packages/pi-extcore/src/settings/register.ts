import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, SettingItem } from "@earendil-works/pi-tui";
import {
	createSettingsPanelComponent,
	type SettingsPanelHost,
	type SettingsPanelPane,
} from "./panel.js";
import { createDefaultSettingsState, mergeSettingsState } from "./state.js";
import type { MaybePromise, SettingChange, SettingGroup, SettingsState } from "./types.js";

export const EXTENSION_SETTING_COMMAND = "extension-setting";

const registryKey = "__hheeiPiExtcoreSettingsRegistry__";
const namespaceSeparator = "/";

type GlobalWithSettingsRegistry = typeof globalThis & {
	[registryKey]?: SettingsRegistry;
};

export interface SettingsStorageAdapter {
	load(ctx: ExtensionContext): MaybePromise<SettingsState | undefined>;
	save(state: SettingsState, ctx: ExtensionContext): MaybePromise<void>;
}

export interface ExtensionSettingsSubpanel {
	id: string;
	label: string;
	description?: string;
	currentValue?: string;
	create: (options: ExtensionSettingsSubpanelCreateOptions) => Component;
}

export interface ExtensionSettingsSubpanelCreateOptions {
	ctx: ExtensionCommandContext;
	host: SettingsPanelHost;
	theme: Theme;
	close: () => void;
}

export interface ExtensionSettingsProvider {
	id: string;
	title: string;
	description?: string;
	generalGroups?: readonly SettingGroup[];
	generalPanels?: readonly ExtensionSettingsSubpanel[];
	groups?: readonly SettingGroup[];
	panels?: readonly ExtensionSettingsSubpanel[];
	storage?: SettingsStorageAdapter;
	onChange?: (change: SettingChange, ctx: ExtensionCommandContext) => MaybePromise<void>;
	onLoad?: (state: SettingsState, ctx: ExtensionContext) => MaybePromise<void>;
}

export interface RegisterExtensionSettingCommandOptions {
	command?: string;
	description?: string;
	title?: string;
	panelDescription?: string;
}

interface RegisteredSettingsProvider extends ExtensionSettingsProvider {
	generalGroups: readonly SettingGroup[];
	generalPanels: readonly ExtensionSettingsSubpanel[];
	groups: readonly SettingGroup[];
	panels: readonly ExtensionSettingsSubpanel[];
	storage: SettingsStorageAdapter;
}

interface SettingsRegistry {
	providers: Map<string, RegisteredSettingsProvider>;
}

interface SavedSettingsEntry {
	state?: SettingsState;
}

export function createSessionSettingsStorage(
	pi: ExtensionAPI,
	customType = "hheei-settings",
): SettingsStorageAdapter {
	return {
		load(ctx) {
			const branch = ctx.sessionManager.getBranch();
			for (let index = branch.length - 1; index >= 0; index -= 1) {
				const entry = branch[index];
				if (entry?.type !== "custom" || entry.customType !== customType) {
					continue;
				}

				const data = entry.data as SavedSettingsEntry | undefined;
				if (data?.state) {
					return data.state;
				}
			}

			return undefined;
		},
		save(state) {
			pi.appendEntry<SavedSettingsEntry>(customType, { state });
		},
	};
}

export function registerExtensionSettings(
	pi: ExtensionAPI,
	provider: ExtensionSettingsProvider,
): void {
	const registry = getSettingsRegistry();
	const registered: RegisteredSettingsProvider = {
		...provider,
		generalGroups: provider.generalGroups ?? [],
		generalPanels: provider.generalPanels ?? [],
		groups: provider.groups ?? [],
		panels: provider.panels ?? [],
		storage: provider.storage ?? createSessionSettingsStorage(pi, `hheei-settings:${provider.id}`),
	};
	registry.providers.set(provider.id, registered);

	const loadState = async (ctx: ExtensionContext): Promise<void> => {
		const savedState = await registered.storage.load(ctx);
		const state = mergeSettingsState(providerSettingGroups(registered), savedState);
		await registered.onLoad?.(state, ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		await loadState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await loadState(ctx);
	});
}

export function getExtensionSettingsProviders(): readonly RegisteredSettingsProvider[] {
	return [...getSettingsRegistry().providers.values()].sort((a, b) =>
		a.title.localeCompare(b.title),
	);
}

export function registerExtensionSettingCommand(
	pi: ExtensionAPI,
	options: RegisterExtensionSettingCommandOptions = {},
): void {
	const command = options.command ?? EXTENSION_SETTING_COMMAND;

	pi.registerCommand(command, {
		description: options.description ?? "Configure installed extension settings",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(`/${command} requires TUI mode`, "error");
				return;
			}

			const providers = getExtensionSettingsProviders();
			if (providers.length === 0) {
				ctx.ui.notify("No extension settings are registered", "info");
				return;
			}

			const providerStates = await loadProviderStates(providers, ctx);
			const onChange = async (change: SettingChange): Promise<void> => {
				const routed = routeProviderChange(providers, providerStates, change);
				if (!routed) {
					return;
				}

				providerStates.set(routed.provider.id, routed.change.state);
				await routed.provider.storage.save(routed.change.state, ctx);
				await routed.provider.onChange?.(routed.change, ctx);
			};

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				createSettingsPanelComponent(tui, theme, {
					title: options.title ?? "Extension Settings",
					description: options.panelDescription,
					panes: createSettingsPanes(providers, providerStates, ctx, tui, theme, onChange),
					onClose: () => done(undefined),
				}),
			);
		},
	});
}

function getSettingsRegistry(): SettingsRegistry {
	const globalWithRegistry = globalThis as GlobalWithSettingsRegistry;
	globalWithRegistry[registryKey] ??= { providers: new Map() };
	return globalWithRegistry[registryKey];
}

async function loadProviderStates(
	providers: readonly RegisteredSettingsProvider[],
	ctx: ExtensionContext,
): Promise<Map<string, SettingsState>> {
	const states = new Map<string, SettingsState>();
	for (const provider of providers) {
		const savedState = await provider.storage.load(ctx);
		states.set(provider.id, mergeSettingsState(providerSettingGroups(provider), savedState));
	}
	return states;
}

function createSettingsPanes(
	providers: readonly RegisteredSettingsProvider[],
	providerStates: ReadonlyMap<string, SettingsState>,
	ctx: ExtensionCommandContext,
	host: SettingsPanelHost,
	theme: Theme,
	onChange: (change: SettingChange) => MaybePromise<void>,
): SettingsPanelPane[] {
	return [
		{
			id: "general",
			title: "General",
			description: "Shared extension settings",
			groups: createGeneralPaneGroups(providers),
			state: createPaneState(providers, providerStates, (provider) => provider.generalGroups),
			extraItems: createSubpanelItems(
				providers,
				(provider) => provider.generalPanels,
				ctx,
				host,
				theme,
				true,
			),
			onChange,
		},
		...providers
			.filter((provider) => provider.groups.length > 0 || provider.panels.length > 0)
			.map((provider) => ({
				id: provider.id,
				title: provider.title,
				description: provider.description,
				groups: namespaceSettingGroups(provider, provider.groups, false),
				state: createPaneState([provider], providerStates, (item) => item.groups),
				extraItems: createSubpanelItems([provider], (item) => item.panels, ctx, host, theme, false),
				onChange,
			})),
	];
}

function createGeneralPaneGroups(providers: readonly RegisteredSettingsProvider[]): SettingGroup[] {
	return providers.flatMap((provider) =>
		namespaceSettingGroups(provider, provider.generalGroups, true),
	);
}

function namespaceSettingGroups(
	provider: RegisteredSettingsProvider,
	groups: readonly SettingGroup[],
	includeProviderTitle: boolean,
): SettingGroup[] {
	return groups.map((group) => ({
		...group,
		id: namespaceGroupId(provider.id, group.id),
		title: includeProviderTitle ? `${provider.title} / ${group.title}` : group.title,
		description:
			[includeProviderTitle ? provider.description : undefined, group.description]
				.filter(Boolean)
				.join(" ") || undefined,
	}));
}

function createSubpanelItems(
	providers: readonly RegisteredSettingsProvider[],
	selectPanels: (provider: RegisteredSettingsProvider) => readonly ExtensionSettingsSubpanel[],
	ctx: ExtensionCommandContext,
	host: SettingsPanelHost,
	theme: Theme,
	includeProviderLabel: boolean,
): SettingItem[] {
	return providers.flatMap((provider) =>
		selectPanels(provider).map((panel) => ({
			id: namespaceGroupId(provider.id, panel.id),
			label: includeProviderLabel ? `${provider.title} / ${panel.label}` : panel.label,
			description:
				[includeProviderLabel ? provider.description : undefined, panel.description]
					.filter(Boolean)
					.join(" ") || undefined,
			currentValue: panel.currentValue ?? "open",
			submenu: (_currentValue: string, close: () => void) =>
				panel.create({ ctx, host, theme, close }),
		})),
	);
}

function createPaneState(
	providers: readonly RegisteredSettingsProvider[],
	providerStates: ReadonlyMap<string, SettingsState>,
	selectGroups: (provider: RegisteredSettingsProvider) => readonly SettingGroup[],
): SettingsState {
	const state: SettingsState = {};
	for (const provider of providers) {
		const providerState =
			providerStates.get(provider.id) ??
			createDefaultSettingsState(providerSettingGroups(provider));
		for (const group of selectGroups(provider)) {
			state[namespaceGroupId(provider.id, group.id)] = providerState[group.id] ?? {};
		}
	}
	return state;
}

function providerSettingGroups(provider: RegisteredSettingsProvider): SettingGroup[] {
	return [...provider.generalGroups, ...provider.groups];
}

function routeProviderChange(
	providers: readonly RegisteredSettingsProvider[],
	providerStates: ReadonlyMap<string, SettingsState>,
	change: SettingChange,
): { provider: RegisteredSettingsProvider; change: SettingChange } | undefined {
	const { providerId, groupId } = splitNamespacedGroupId(change.groupId);
	const provider = providers.find((item) => item.id === providerId);
	if (!provider) {
		return undefined;
	}

	const currentState =
		providerStates.get(provider.id) ?? createDefaultSettingsState(providerSettingGroups(provider));
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

function namespaceGroupId(providerId: string, groupId: string): string {
	return `${providerId}${namespaceSeparator}${groupId}`;
}

function splitNamespacedGroupId(groupId: string): { providerId: string; groupId: string } {
	const index = groupId.indexOf(namespaceSeparator);
	if (index === -1) {
		return { providerId: "", groupId };
	}

	return {
		providerId: groupId.slice(0, index),
		groupId: groupId.slice(index + namespaceSeparator.length),
	};
}
