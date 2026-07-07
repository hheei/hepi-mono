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
	type SettingsPanelInput,
	type SettingsPanelPane,
} from "./panel.js";
import {
	createGeneralPaneGroups,
	createPaneState,
	createProviderState,
	loadProviderState,
	loadProviderStates,
	namespaceGroupId,
	namespaceSettingGroups,
	normalizeSettingsProvider,
	type RegisteredSettingsProvider,
	routeProviderChange,
} from "./provider.js";
import type { MaybePromise, SettingChange, SettingGroup, SettingsState } from "./types.js";

export const EXTENSION_SETTING_COMMAND = "extension-setting";

const registryKey = "__hheeiPiExtcoreSettingsRegistry__";
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
	getState: () => SettingsState;
	saveState: (state: SettingsState) => MaybePromise<void>;
	onError: (error: unknown) => void;
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
	onClose?: (state: SettingsState, ctx: ExtensionCommandContext) => MaybePromise<void>;
	onInput?: (
		input: SettingsPanelInput,
		ctx: ExtensionCommandContext,
		theme: Theme,
	) => MaybePromise<boolean | undefined>;
}

export interface RegisterExtensionSettingCommandOptions {
	command?: string;
	description?: string;
	title?: string;
	panelDescription?: string;
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
	const registered = normalizeSettingsProvider(provider);
	registry.providers.set(provider.id, registered);

	const loadState = async (ctx: ExtensionContext): Promise<void> => {
		const state = await loadProviderState(registered, ctx);
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

			const onError = (error: unknown): void => notifySettingsError(ctx, error);
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

				await routed.provider.storage.save(routed.change.state, ctx);
				providerStates.set(routed.provider.id, routed.change.state);
				await routed.provider.onChange?.(routed.change, ctx);
			};

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const closeSettings = () => {
					void Promise.all(
						providers.map((provider) => {
							const state = providerStates.get(provider.id);
							return state ? provider.onClose?.(state, ctx) : undefined;
						}),
					)
						.catch(onError)
						.finally(() => done(undefined));
				};

				return createSettingsPanelComponent(tui, theme, {
					title: options.title ?? "Extension Settings",
					description: options.panelDescription,
					panes: createSettingsPanes(providers, providerStates, ctx, tui, theme, onChange, onError),
					onError,
					onClose: closeSettings,
				});
			});
		},
	});
}

function getSettingsRegistry(): SettingsRegistry {
	const globalWithRegistry = globalThis as GlobalWithSettingsRegistry;
	globalWithRegistry[registryKey] ??= { providers: new Map() };
	return globalWithRegistry[registryKey];
}

function createSettingsPanes(
	providers: readonly RegisteredSettingsProvider[],
	providerStates: Map<string, SettingsState>,
	ctx: ExtensionCommandContext,
	host: SettingsPanelHost,
	theme: Theme,
	onChange: (change: SettingChange) => MaybePromise<void>,
	onError: (error: unknown) => void,
): SettingsPanelPane[] {
	return [
		{
			id: "general",
			title: "General",
			groups: createGeneralPaneGroups(providers),
			state: createPaneState(providers, providerStates, (provider) => provider.generalGroups),
			getState: () =>
				createPaneState(providers, providerStates, (provider) => provider.generalGroups),
			extraItems: createSubpanelItems(
				providers,
				(provider) => provider.generalPanels,
				ctx,
				host,
				theme,
				providerStates,
				onError,
				true,
			),
			onChange,
		},
		...providers
			.filter((provider) => provider.groups.length > 0 || provider.panels.length > 0)
			.map((provider) => ({
				id: provider.id,
				title: provider.title,
				groups: namespaceSettingGroups(provider, provider.groups, false),
				state: createPaneState([provider], providerStates, (item) => item.groups),
				getState: () => createPaneState([provider], providerStates, (item) => item.groups),
				onInput: (input: SettingsPanelInput) => provider.onInput?.(input, ctx, theme),
				extraItems: createSubpanelItems(
					[provider],
					(item) => item.panels,
					ctx,
					host,
					theme,
					providerStates,
					onError,
					false,
				),
				onChange,
			})),
	];
}

function createSubpanelItems(
	providers: readonly RegisteredSettingsProvider[],
	selectPanels: (provider: RegisteredSettingsProvider) => readonly ExtensionSettingsSubpanel[],
	ctx: ExtensionCommandContext,
	host: SettingsPanelHost,
	theme: Theme,
	providerStates: Map<string, SettingsState>,
	onError: (error: unknown) => void,
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
				panel.create({
					ctx,
					host,
					theme,
					close,
					getState: () => createProviderState(provider, providerStates),
					saveState: async (state) => {
						try {
							await provider.storage.save(state, ctx);
							providerStates.set(provider.id, state);
						} catch (error) {
							onError(error);
							throw error;
						}
					},
					onError,
				}),
		})),
	);
}

function notifySettingsError(ctx: ExtensionCommandContext, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	ctx.ui.notify(`Settings update failed: ${message}`, "error");
}
