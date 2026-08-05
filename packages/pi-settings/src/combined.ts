import type {
	HepiContext,
	HepiSettingChange,
	HepiSettingsProvider,
	HepiSettingsState,
} from "@hheei/pi-ext-core";

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

/**
 * Projects independent provider groups into the legacy single Settings tree.
 * Display IDs solve UI collisions only; every storage and callback boundary is
 * mapped back to the provider's own group IDs before it crosses package ownership.
 */
export function combineSettingsProviders(
	providers: readonly HepiSettingsProvider[],
): HepiSettingsProvider {
	const usedGroupIds = new Set<string>();
	const seenModules = new Set<string>();
	const mappings: readonly GroupMapping[] = providers.flatMap((provider) => {
		const moduleName = providerModuleName(provider);
		return provider.groups.map((group, index) => {
			const baseId = usedGroupIds.has(group.id) ? `${provider.id}:${group.id}` : group.id;
			let displayId = baseId;
			let suffix = 2;
			while (usedGroupIds.has(displayId)) displayId = `${baseId}:${suffix++}`;
			usedGroupIds.add(displayId);
			const firstVisibleGroup = provider.groups.findIndex(
				(candidate) => candidate.fields.length > 0,
			);
			const showModuleHeader = index === firstVisibleGroup && !seenModules.has(moduleName);
			if (showModuleHeader) seenModules.add(moduleName);
			return { displayId, originalId: group.id, moduleName, showModuleHeader, provider, group };
		});
	});
	const providerState = (
		state: HepiSettingsState,
		provider: HepiSettingsProvider,
	): HepiSettingsState =>
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
			return enabled === undefined
				? field
				: {
						...field,
						enabled: (state: HepiSettingsState) => enabled(providerState(state, provider)),
					};
		}),
	}));
	const owners = new Map(mappings.map((mapping) => [mapping.displayId, mapping]));

	return {
		id: "pi-settings",
		title: "Settings",
		origin: "@hheei/pi-settings",
		description: "Settings supplied by installed HEPI extensions.",
		groups,
		panels: providers.flatMap((provider) => provider.panels ?? []),
		storage: {
			async load(context: HepiContext): Promise<HepiSettingsState> {
				const entries = await Promise.all(
					providers.map(
						async (provider) => [provider, await provider.storage.load(context)] as const,
					),
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
			async save(state: HepiSettingsState, context: HepiContext): Promise<void> {
				// Keep provider writes ordered. Individual storage implementations own their
				// atomic root update; unrelated provider files are not a transaction.
				for (const provider of providers)
					await provider.storage.save(providerState(state, provider), context);
			},
			async validate(state: HepiSettingsState, context: HepiContext): Promise<void> {
				for (const provider of providers)
					await provider.storage.validate?.(providerState(state, provider), context);
			},
			async close(context: HepiContext): Promise<void> {
				for (const provider of providers) await provider.storage.close?.(context);
			},
		},
		onLoad: async (state, context): Promise<void> => {
			for (const provider of providers)
				await provider.onLoad?.(providerState(state, provider), context);
		},
		onChange: async (change: HepiSettingChange, context: HepiContext): Promise<void> => {
			const mapping = owners.get(change.groupId);
			if (mapping?.provider.onChange === undefined) return;
			await mapping.provider.onChange(
				{
					...change,
					groupId: mapping.originalId,
					state: providerState(change.state, mapping.provider),
				},
				context,
			);
		},
		onClose: async (state, context): Promise<void> => {
			for (const provider of providers)
				await provider.onClose?.(providerState(state, provider), context);
		},
	};
}
