export { default } from "./extension.js";
export {
	CATEGORY_GLYPH,
	CATEGORY_LABEL,
	enabledBadge,
	overrideBadge,
	scopeBadge,
	scopeLabel,
} from "./glyph.js";
export {
	LoadoutManager,
	type LoadoutManagerOptions,
	resourceDisplayName,
} from "./loadout-manager.js";
export {
	LIST_HEADER_ROWS,
	LIST_HINT_ROWS,
	LoadoutView,
	type LoadoutViewOptions,
	PANEL_ROWS,
	VISIBLE_ROWS,
} from "./loadout-view.js";
export {
	computeEffectiveEnabled,
	computeResourcePattern,
	matchesPattern,
	nextOverrideState,
	ResourcePatternStore,
	type ResourcePatternStoreOptions,
	resolveOverrideFromEntries,
	stripPatternModifier,
	updatePatternEntries,
} from "./pattern-store.js";
export type {
	LoadoutGroup,
	LoadoutItem,
	LoadoutScope,
	ProjectOverrideState,
	ResourceCategory,
	ResourceOrigin,
} from "./types.js";
