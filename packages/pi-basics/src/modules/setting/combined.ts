import type {
	HePiContext,
	HePiSettingChange,
	HePiSettingsProvider,
	HePiSettingsState,
} from "../../api/settings.js";

interface GroupMapping {
	readonly displayId: string;
	readonly originalId: string;
	readonly provider: HePiSettingsProvider;
}

/** Presents module-owned settings as one Pi Basics settings tree while preserving each module's storage contract. */
export function combineSettingsProviders(
	providers: readonly HePiSettingsProvider[],
): HePiSettingsProvider {
	const usedGroupIds = new Set<string>();
	const mappings: readonly GroupMapping[] = providers.flatMap((provider) =>
		provider.groups.map((group) => {
			let displayId = group.id;
			if (usedGroupIds.has(displayId)) displayId = `${provider.id}:${group.id}`;
			usedGroupIds.add(displayId);
			return { displayId, originalId: group.id, provider };
		}),
	);
	const groups = mappings.map(({ displayId, originalId, provider }) => {
		const group = provider.groups.find((candidate) => candidate.id === originalId)!;
		return { ...group, id: displayId };
	});
	const owners = new Map(mappings.map((mapping) => [mapping.displayId, mapping]));

	const providerState = (state: HePiSettingsState, provider: HePiSettingsProvider) =>
		Object.fromEntries(
			mappings
				.filter((mapping) => mapping.provider === provider)
				.map(({ displayId, originalId }) => [originalId, state[displayId] ?? {}]),
		);

	return {
		id: "pi-basics-settings",
		title: "Pi Basics",
		origin: "@pi-basics",
		description: "Settings provided by Pi Basics modules.",
		groups,
		panels: providers.flatMap((provider) => provider.panels ?? []),
		storage: {
			async load(ctx: HePiContext) {
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
			async save(state: HePiSettingsState, ctx: HePiContext) {
				for (const provider of providers)
					await provider.storage.save(providerState(state, provider), ctx);
			},
			async close(ctx: HePiContext) {
				for (const provider of providers) await provider.storage.close?.(ctx);
			},
		},
		onLoad: async (state, ctx) => {
			for (const provider of providers) await provider.onLoad?.(providerState(state, provider), ctx);
		},
		onChange: async (change: HePiSettingChange, ctx: HePiContext) => {
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
