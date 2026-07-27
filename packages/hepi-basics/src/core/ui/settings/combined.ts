import type {
	HepiContext,
	HepiSettingChange,
	HepiSettingsProvider,
	HepiSettingsState,
} from "../../api/settings.js";

interface GroupMapping {
	readonly displayId: string;
	readonly originalId: string;
	readonly moduleName: string;
	readonly showModuleHeader: boolean;
	readonly provider: HepiSettingsProvider;
	readonly group: HepiSettingsProvider["groups"][number];
}

function providerModuleName(provider: HepiSettingsProvider): string {
	if (provider.moduleName !== undefined) return provider.moduleName;
	const originName = provider.origin?.split("/").at(-1);
	if (originName?.startsWith("pi-") && originName !== "pi-basics") return originName;
	if (provider.id.startsWith("pi-basics-")) return `pi-${provider.id.slice("pi-basics-".length)}`;
	return provider.id.startsWith("pi-") ? provider.id : `pi-${provider.id}`;
}

/** Presents module-owned settings as one Pi Basics settings tree while preserving each module's storage contract. */
export function combineSettingsProviders(
	providers: readonly HepiSettingsProvider[],
): HepiSettingsProvider {
	const usedGroupIds = new Set<string>();
	const seenModules = new Set<string>();
	const mappings: readonly GroupMapping[] = providers.flatMap((provider) => {
		const moduleName = providerModuleName(provider);
		return provider.groups.map((group, index) => {
			let displayId = group.id;
			if (usedGroupIds.has(displayId)) displayId = `${provider.id}:${group.id}`;
			usedGroupIds.add(displayId);
			const showModuleHeader = index === 0 && !seenModules.has(moduleName);
			seenModules.add(moduleName);
			return {
				displayId,
				originalId: group.id,
				moduleName,
				showModuleHeader,
				provider,
				group,
			};
		});
	});
	const providerState = (state: HepiSettingsState, provider: HepiSettingsProvider) =>
		Object.fromEntries(
			mappings
				.filter((mapping) => mapping.provider === provider)
				.map(({ displayId, originalId }) => [originalId, state[displayId] ?? {}]),
		);
	const groups = mappings.map(({ displayId, moduleName, showModuleHeader, provider, group }) => ({
		...group,
		id: displayId,
		title: showModuleHeader ? moduleName : "",
		fields: group.fields.map((field) => {
			const enabled = field.enabled;
			return enabled
				? {
						...field,
						enabled: (state: HepiSettingsState) => enabled(providerState(state, provider)),
					}
				: field;
		}),
	}));
	const owners = new Map(mappings.map((mapping) => [mapping.displayId, mapping]));

	return {
		id: "pi-basics-settings",
		title: "Pi Basics",
		origin: "@hheei/hepi-basics",
		description: "Settings provided by Pi Basics modules.",
		groups,
		panels: providers.flatMap((provider) => provider.panels ?? []),
		storage: {
			async load(ctx: HepiContext) {
				const entries = await Promise.all(
					providers.map(async (provider) => [provider, await provider.storage.load(ctx)] as const),
				);
				return Object.assign(
					{},
					...entries.map(([provider, state]) =>
						Object.fromEntries(
							mappings
								.filter((mapping) => mapping.provider === provider)
								.map(({ displayId, originalId }) => [displayId, state?.[originalId] ?? {}]),
						),
					),
				);
			},
			async save(state: HepiSettingsState, ctx: HepiContext) {
				for (const provider of providers)
					await provider.storage.save(providerState(state, provider), ctx);
			},
			async close(ctx: HepiContext) {
				for (const provider of providers) await provider.storage.close?.(ctx);
			},
		},
		onLoad: async (state, ctx) => {
			for (const provider of providers)
				await provider.onLoad?.(providerState(state, provider), ctx);
		},
		onChange: async (change: HepiSettingChange, ctx: HepiContext) => {
			const mapping = owners.get(change.groupId);
			if (!mapping?.provider.onChange) return;
			await mapping.provider.onChange(
				{
					...change,
					groupId: mapping.originalId,
					state: providerState(change.state, mapping.provider),
				},
				ctx,
			);
		},
		onClose: async (state, ctx) => {
			for (const provider of providers)
				await provider.onClose?.(providerState(state, provider), ctx);
		},
	};
}
