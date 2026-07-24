export interface LoadoutDescriptionPanel {
	readonly title?: string;
	readonly lines?: readonly string[];
	readonly render?: (width: number) => readonly string[];
}

export interface LoadoutDescriptionRegistry {
	register(key: string, panel: LoadoutDescriptionPanel): void;
	unregister(key: string): void;
	get(item: Pick<LoadoutItem, "key" | "kind" | "name">): LoadoutDescriptionPanel | undefined;
}

class DescriptionRegistry implements LoadoutDescriptionRegistry {
	readonly #panels = new Map<string, LoadoutDescriptionPanel>();
	register(key: string, panel: LoadoutDescriptionPanel): void {
		if (!key.trim()) throw new Error("Loadout description panel key cannot be empty");
		this.#panels.set(key, panel);
	}
	unregister(key: string): void {
		this.#panels.delete(key);
	}
	get(item: Pick<LoadoutItem, "key" | "kind" | "name">): LoadoutDescriptionPanel | undefined {
		return (
			this.#panels.get(item.key) ??
			this.#panels.get(`${item.kind}:${item.name}`) ??
			this.#panels.get(item.name)
		);
	}
}

export function createLoadoutDescriptionRegistry(): LoadoutDescriptionRegistry {
	return new DescriptionRegistry();
}

export type LoadoutScope = "global" | "project";
export type LoadoutKind = "mcp" | "tool" | "skill";
export type LoadoutKey = `${LoadoutKind}:${string}`;
export type LoadoutConfiguredStatus = "active" | "disabled" | "inherit";
export type LoadoutEffectiveStatus = "active" | "disabled";
export type LoadoutDisplayStatus = "active" | "disabled" | "inherit";
export type LoadoutSourceScope = "global" | "project";

export interface LoadoutItem {
	readonly key: LoadoutKey;
	readonly name: string;
	readonly kind: LoadoutKind;
	readonly sourceScope: LoadoutSourceScope;
	readonly hasGlobalDefinition: boolean;
	readonly origin: string;
	readonly description?: string | undefined;
	readonly instruction?: string | undefined;
	readonly descriptionPanel?: LoadoutDescriptionPanel | undefined;
	readonly tokenCount?: number;
	readonly parentMcpKey?: `mcp:${string}`;
	readonly conflictGroup?: string;
}

export interface LoadoutResolvedItem extends LoadoutItem {
	readonly configuredStatus: LoadoutConfiguredStatus;
	readonly effectiveStatus: LoadoutEffectiveStatus;
	readonly displayStatus: LoadoutDisplayStatus;
	readonly lockedBy?: LoadoutKey;
}

export type LoadoutMap = Readonly<Record<string, boolean>>;
export interface LoadoutStatusMaps {
	readonly global: LoadoutMap;
	readonly project: LoadoutMap;
}

const KIND_ORDER: Record<LoadoutKind, number> = { mcp: 0, tool: 1, skill: 2 };

export function parseLoadoutKey(key: string): LoadoutKey | undefined {
	const separator = key.indexOf(":");
	if (separator <= 0 || separator === key.length - 1) return undefined;
	const kind = key.slice(0, separator);
	if (kind !== "mcp" && kind !== "tool" && kind !== "skill") return undefined;
	return key as LoadoutKey;
}

export function loadoutKey(kind: LoadoutKind, name: string, source?: string): LoadoutKey {
	return source ? `${kind}:${source}:${name}` : `${kind}:${name}`;
}
export function loadoutPersistenceKey(item: LoadoutItem): LoadoutKey {
	return `${item.kind}:${item.name}`;
}
function configuredValue(map: LoadoutMap, item: LoadoutItem): boolean | undefined {
	return map[loadoutPersistenceKey(item)];
}

function inheritsGlobalConfiguration(item: LoadoutItem, maps: LoadoutStatusMaps): boolean {
	return item.hasGlobalDefinition || configuredValue(maps.global, item) !== undefined;
}

export function resolveConfiguredStatus(
	item: LoadoutItem,
	scope: LoadoutScope,
	maps: LoadoutStatusMaps,
): LoadoutConfiguredStatus {
	if (scope === "global")
		return configuredValue(maps.global, item) === false ? "disabled" : "active";
	if (!inheritsGlobalConfiguration(item, maps))
		return configuredValue(maps.project, item) === false ? "disabled" : "active";
	const projectValue = configuredValue(maps.project, item);
	if (projectValue !== undefined) return projectValue ? "active" : "disabled";
	return "inherit";
}

export function resolveEffectiveStatus(
	configured: LoadoutConfiguredStatus,
	globalStatus: LoadoutEffectiveStatus,
): LoadoutEffectiveStatus {
	return configured === "inherit" ? globalStatus : configured;
}

export function resolveDisplayStatus(
	configured: LoadoutConfiguredStatus,
	globalStatus: LoadoutEffectiveStatus,
): LoadoutDisplayStatus {
	return configured === "inherit" && globalStatus === "disabled" ? "disabled" : configured;
}

export function resolveLoadoutItem(
	item: LoadoutItem,
	scope: LoadoutScope,
	maps: LoadoutStatusMaps,
): LoadoutResolvedItem {
	const configuredStatus = resolveConfiguredStatus(item, scope, maps);
	const globalConfigured = resolveConfiguredStatus(item, "global", maps);
	const globalStatus: LoadoutEffectiveStatus =
		globalConfigured === "disabled" ? "disabled" : "active";
	return {
		...item,
		configuredStatus,
		effectiveStatus: resolveEffectiveStatus(configuredStatus, globalStatus),
		displayStatus: resolveDisplayStatus(configuredStatus, globalStatus),
	};
}
export function resolveLoadoutItems(
	items: readonly LoadoutItem[],
	scope: LoadoutScope,
	maps: LoadoutStatusMaps,
): readonly LoadoutResolvedItem[] {
	const resolved = sortLoadoutItems(items).map((item) => resolveLoadoutItem(item, scope, maps));
	const activeByGroup = new Map<string, LoadoutResolvedItem>();
	for (const item of resolved) {
		if (item.kind !== "tool" || !item.conflictGroup || item.effectiveStatus !== "active") continue;
		if (!activeByGroup.has(item.conflictGroup)) activeByGroup.set(item.conflictGroup, item);
	}
	return resolved.map((item) => {
		if (item.kind !== "tool" || !item.conflictGroup || item.effectiveStatus !== "active")
			return item;
		const winner = activeByGroup.get(item.conflictGroup);
		if (!winner || winner.key === item.key) return item;
		return {
			...item,
			effectiveStatus: "disabled",
			displayStatus: "disabled",
			lockedBy: winner.key,
		};
	});
}

export function nextConfiguredStatus(
	item: LoadoutItem,
	scope: LoadoutScope,
	maps: LoadoutStatusMaps,
): LoadoutConfiguredStatus {
	const current = resolveConfiguredStatus(item, scope, maps);
	if (scope === "project" && inheritsGlobalConfiguration(item, maps)) {
		const globalDisabled = resolveConfiguredStatus(item, "global", maps) === "disabled";
		if (globalDisabled) return current === "active" ? "disabled" : "active";
		return current === "inherit" ? "active" : current === "active" ? "disabled" : "inherit";
	}
	return current === "active" ? "disabled" : "active";
}

function loadoutPackageSortKey(origin: string): string {
	const normalized = origin.trim().toLocaleLowerCase();
	return normalized === "" ||
		normalized === "builtin" ||
		normalized === "core" ||
		normalized === "built-in"
		? ""
		: normalized;
}

export function sortLoadoutItems(items: readonly LoadoutItem[]): readonly LoadoutItem[] {
	return [...items].sort((a, b) => {
		const kindOrder = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
		if (kindOrder !== 0) return kindOrder;
		const packageOrder = loadoutPackageSortKey(a.origin).localeCompare(
			loadoutPackageSortKey(b.origin),
			undefined,
			{ sensitivity: "base" },
		);
		return (
			packageOrder ||
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
			a.key.localeCompare(b.key)
		);
	});
}

export function toggleLoadoutState(
	item: LoadoutItem,
	scope: LoadoutScope,
	maps: LoadoutStatusMaps,
): LoadoutStatusMaps {
	const next = nextConfiguredStatus(item, scope, maps);
	const key = loadoutPersistenceKey(item);
	const global = { ...maps.global };
	const project = { ...maps.project };
	if (scope === "global") global[key] = next === "active";
	else if (inheritsGlobalConfiguration(item, maps) && next === "inherit") delete project[key];
	else project[key] = next === "active";
	return { global, project };
}

export interface LoadoutGroup {
	readonly kind: LoadoutKind;
	readonly items: readonly LoadoutItem[];
}

export function groupLoadoutItems(items: readonly LoadoutItem[]): readonly LoadoutGroup[] {
	const sorted = sortLoadoutItems(items);
	return (["mcp", "tool", "skill"] as const)
		.map((kind) => ({ kind, items: sorted.filter((item) => item.kind === kind) }))
		.filter((group) => group.items.length > 0);
}

export function filterLoadoutItems(
	items: readonly LoadoutItem[],
	query: string,
): readonly LoadoutItem[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return sortLoadoutItems(items);
	return sortLoadoutItems(items).filter((item) =>
		[item.key, item.name, item.origin, item.description, item.instruction]
			.filter((value): value is string => value !== undefined)
			.some((value) => value.toLocaleLowerCase().includes(needle)),
	);
}

export function reconcileLoadoutSelection(
	items: readonly LoadoutItem[],
	selectedKey: LoadoutKey | undefined,
	previousItems: readonly LoadoutItem[] = items,
): LoadoutKey | undefined {
	const visible = sortLoadoutItems(items);
	if (visible.length === 0) return undefined;
	if (!selectedKey || visible.some((item) => item.key === selectedKey))
		return selectedKey ?? visible[0]?.key;
	const previous = sortLoadoutItems(previousItems);
	const selectedIndex = previous.findIndex((item) => item.key === selectedKey);
	const selectedKind =
		selectedIndex >= 0
			? previous[selectedIndex]?.kind
			: (parseLoadoutKey(selectedKey)?.split(":", 1)[0] as LoadoutKind | undefined);
	if (selectedKind) {
		const later =
			selectedIndex >= 0
				? previous
						.slice(selectedIndex + 1)
						.find(
							(item) =>
								item.kind === selectedKind &&
								visible.some((candidate) => candidate.key === item.key),
						)
				: undefined;
		if (later) return later.key;
		const sameGroup = visible.find((item) => item.kind === selectedKind);
		if (sameGroup) return sameGroup.key;
	}
	return visible[0]?.key;
}
