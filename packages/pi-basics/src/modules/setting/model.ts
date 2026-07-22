import type {
	HePiSettingField,
	HePiSettingGroup,
	HePiSettingsProvider,
	HePiSettingsState,
	HePiSettingValue,
} from "../../api/settings.js";

export type SettingsMode = "Navigation" | "Edit";
export interface SettingsSelection {
	readonly providerId: string;
	/** Public field.id or stable group/panel item identity. */
	readonly itemId?: string;
	readonly groupId?: string;
}
export interface SettingsProviderSnapshot {
	readonly provider: HePiSettingsProvider;
	readonly groups: readonly HePiSettingGroup[];
	readonly fields: readonly (HePiSettingField & { readonly groupId: string })[];
	readonly panels: readonly NonNullable<HePiSettingsProvider["panels"]>[number][];
}
export interface SettingsModelState {
	readonly providers: readonly SettingsProviderSnapshot[];
	readonly activeProviderId?: string;
	readonly selection?: SettingsSelection;
	readonly mode: SettingsMode;
	readonly committed: Readonly<Record<string, HePiSettingsState>>;
	readonly draftValue?: string;
	readonly search: string;
	readonly collapsedGroupIds: ReadonlySet<string>;
	readonly scrollTop: number;
	readonly error?: string;
}

export function settingGroupItemId(groupId: string): string {
	return `group:${groupId}`;
}
export function settingFieldItemId(groupId: string, fieldId: string): string {
	return `field:${groupId}:${fieldId}`;
}
export function settingPanelItemId(panelId: string): string {
	return `panel:${panelId}`;
}

export function providerHasContent(provider: HePiSettingsProvider): boolean {
	return (
		provider.groups.some((group) => group.fields.length > 0) || (provider.panels?.length ?? 0) > 0
	);
}

export function snapshotProvider(provider: HePiSettingsProvider): SettingsProviderSnapshot {
	const groups = provider.groups.filter((group) => group.fields.length > 0);
	return {
		provider,
		groups,
		fields: groups.flatMap((group) =>
			group.fields.map((field) => ({ ...field, groupId: group.id })),
		),
		panels: [...(provider.panels ?? [])],
	};
}

export function mergeSettingsState(
	provider: HePiSettingsProvider,
	stored: HePiSettingsState | undefined,
): HePiSettingsState {
	const result: HePiSettingsState = {};
	const storedState = stored ?? {};
	for (const group of provider.groups) {
		const storedGroup = storedState[group.id] ?? {};
		const fields: Record<string, HePiSettingValue> = {};
		for (const field of group.fields) {
			fields[field.id] = Object.hasOwn(storedGroup, field.id)
				? storedGroup[field.id]!
				: field.defaultValue;
		}
		// Preserve unknown fields from storage; domain state owns them.
		result[group.id] = { ...storedGroup, ...fields };
	}
	for (const [groupId, values] of Object.entries(storedState)) {
		if (!(groupId in result)) result[groupId] = { ...values };
	}
	return result;
}

export function fieldForSelection(
	snapshot: SettingsProviderSnapshot | undefined,
	itemId: string | undefined,
	groupId?: string,
): (HePiSettingField & { readonly groupId: string }) | undefined {
	if (!snapshot || itemId === undefined) return undefined;
	return (
		snapshot.fields.find(
			(field) => field.id === itemId && (!groupId || field.groupId === groupId),
		) ?? snapshot.fields.find((field) => settingFieldItemId(field.groupId, field.id) === itemId)
	);
}

export function visibleFields(
	snapshot: SettingsProviderSnapshot | undefined,
	search: string,
	collapsedGroupIds: ReadonlySet<string>,
): readonly (HePiSettingField & { readonly groupId: string })[] {
	if (!snapshot) return [];
	const query = search.trim().toLocaleLowerCase();
	return snapshot.fields.filter((field) => {
		if (collapsedGroupIds.has(field.groupId) && !query) return false;
		return (
			!query ||
			`${field.label} ${field.id} ${field.description ?? ""}`.toLocaleLowerCase().includes(query)
		);
	});
}

export function cycleOption<T extends boolean | number | string>(
	field: HePiSettingField<T>,
	value: T,
	direction = 1,
): T {
	if (!field.options?.length) throw new Error(`Setting has no options: ${field.id}`);
	const index = field.options.findIndex((option) => Object.is(option.value, value));
	if (index < 0) throw new Error(`Invalid option for setting: ${field.id}`);
	return field.options[(index + direction + field.options.length) % field.options.length]!.value;
}

export class SettingsModel {
	state: SettingsModelState;
	constructor(providers: readonly HePiSettingsProvider[] = []) {
		const snapshots = providers.filter(providerHasContent).map(snapshotProvider);
		const first = snapshots[0];
		const firstField = first?.fields[0];
		this.state = {
			providers: snapshots,
			activeProviderId: first?.provider.id,
			selection: firstField
				? { providerId: first!.provider.id, itemId: firstField.id, groupId: firstField.groupId }
				: first?.panels[0]
					? { providerId: first.provider.id, itemId: settingPanelItemId(first.panels[0].id) }
					: undefined,
			mode: "Navigation",
			committed: {},
			draftValue: undefined,
			search: "",
			collapsedGroupIds: new Set(),
			scrollTop: 0,
		};
	}
	get active(): SettingsProviderSnapshot | undefined {
		return this.state.providers.find((p) => p.provider.id === this.state.activeProviderId);
	}
	get selectedField() {
		return fieldForSelection(
			this.active,
			this.state.selection?.itemId,
			this.state.selection?.groupId,
		);
	}
	setCommitted(providerId: string, value: HePiSettingsState): void {
		this.state = { ...this.state, committed: { ...this.state.committed, [providerId]: value } };
	}
	select(itemId: string): void {
		if (!this.state.activeProviderId) return;
		const snapshot = this.active;
		const field =
			snapshot?.fields.find(
				(candidate) => settingFieldItemId(candidate.groupId, candidate.id) === itemId,
			) ?? snapshot?.fields.find((candidate) => candidate.id === itemId);
		const groupId = field?.groupId;
		this.state = {
			...this.state,
			selection: {
				providerId: this.state.activeProviderId,
				itemId: field?.id ?? itemId,
				...(groupId ? { groupId } : {}),
			},
		};
	}
	setSearch(search: string): void {
		const old = this.state.selection;
		const fields = visibleFields(this.active, search, this.state.collapsedGroupIds);
		const query = search.trim().toLocaleLowerCase();
		const panels =
			this.active?.panels.filter(
				(panel) => !query || `${panel.label ?? ""} ${panel.id}`.toLocaleLowerCase().includes(query),
			) ?? [];
		const fieldStillVisible = fields.some(
			(field) => field.id === old?.itemId && field.groupId === old?.groupId,
		);
		const panelStillVisible = panels.some((panel) => settingPanelItemId(panel.id) === old?.itemId);
		const next =
			fieldStillVisible || panelStillVisible
				? old
				: fields[0]
					? {
							providerId: this.state.activeProviderId!,
							itemId: fields[0].id,
							groupId: fields[0].groupId,
						}
					: panels[0]
						? { providerId: this.state.activeProviderId!, itemId: settingPanelItemId(panels[0].id) }
						: { providerId: this.state.activeProviderId! };
		this.state = { ...this.state, search, selection: next, scrollTop: 0 };
	}
	toggleGroup(_groupId: string): void {
		// Group headers are structural labels; fields remain permanently visible.
	}
	beginEdit(value: string): void {
		this.state = { ...this.state, mode: "Edit", draftValue: value, error: undefined };
	}
	cancelEdit(): void {
		this.state = { ...this.state, mode: "Navigation", draftValue: undefined, error: undefined };
	}
	setDraftValue(value: string): void {
		this.state = { ...this.state, draftValue: value };
	}
	setError(error: string | undefined): void {
		this.state = { ...this.state, error };
	}
	setProvider(providerId: string): void {
		const snapshot = this.state.providers.find((p) => p.provider.id === providerId);
		const fields = visibleFields(snapshot, this.state.search, this.state.collapsedGroupIds);
		const query = this.state.search.trim().toLocaleLowerCase();
		const panels =
			snapshot?.panels.filter(
				(panel) => !query || `${panel.label ?? ""} ${panel.id}`.toLocaleLowerCase().includes(query),
			) ?? [];
		const old = this.state.selection;
		const fieldStillVisible = fields.some(
			(field) => field.id === old?.itemId && field.groupId === old?.groupId,
		);
		const panelStillVisible = panels.some((panel) => settingPanelItemId(panel.id) === old?.itemId);
		const selection =
			fieldStillVisible || panelStillVisible
				? { ...old!, providerId }
				: fields[0]
					? { providerId, itemId: fields[0].id, groupId: fields[0].groupId }
					: panels[0]
						? { providerId, itemId: settingPanelItemId(panels[0].id) }
						: { providerId };
		this.state = { ...this.state, activeProviderId: providerId, selection, scrollTop: 0 };
	}
}

export function createSettingsModel(
	providers: readonly HePiSettingsProvider[] = [],
): SettingsModel {
	return new SettingsModel(providers);
}
