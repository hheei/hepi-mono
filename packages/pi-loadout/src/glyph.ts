import type { Theme } from "@earendil-works/pi-coding-agent";
import type { LoadoutItem, ProjectOverrideState, ResourceCategory } from "./types.js";

/**
 * The Nerd Font vocabulary for the loadout surface, shared with the todo rows, the framed tool
 * status, and the subagent panel so one symbol never means two things: a marked circle is on, a
 * blank circle is off, and the plus/minus circles are explicit project decisions.
 *
 * Glyphs are written as `\u{...}` escapes rather than literal characters because the BMP range
 * these icons live in also accepts four-hex-digit escapes, and `"\uf0134"` silently parses as
 * `U+F013` followed by `"4"` — two cells of the wrong icon instead of one cell of the right one.
 */
const ON = "\u{f0134}";
const OFF = "\u{f0130}";
const LOAD = "\u{f0419}";
const UNLOAD = "\u{f0377}";

/** One icon per resource category, used by the category headings and the surface title. */
export const CATEGORY_GLYPH: Record<ResourceCategory, string> = {
	skills: "\u{f09d1}",
	extensions: "\u{f0431}",
	prompts: "\u{f021a}",
	themes: "\u{f04d8}",
	packages: "\u{f04d3}",
	tools: "\u{f05b7}",
};

export const CATEGORY_LABEL: Record<ResourceCategory, string> = {
	skills: "Skills",
	extensions: "Extensions",
	prompts: "Prompts",
	themes: "Themes",
	packages: "Packages",
	tools: "Tools",
};

/** Draws an enabled/disabled fact. `dim` is hierarchy, not failure, so "off" is never alarming. */
export function enabledBadge(enabled: boolean, theme: Theme): string {
	return enabled ? theme.fg("success", ON) : theme.fg("dim", OFF);
}

/** Draws an explicit project decision; `undefined` when the project inherits the global layer. */
export function overrideBadge(override: ProjectOverrideState, theme: Theme): string | undefined {
	if (override === "load") return theme.fg("success", LOAD);
	if (override === "unload") return theme.fg("warning", UNLOAD);
	return undefined;
}

/**
 * The badge for one row of the list, which reports what the scope being edited will do: the global
 * layer's own value in the global scope, and the project decision or its inherited value in the
 * project scope. The effective result is a separate fact and belongs in the detail pane.
 */
export function scopeBadge(item: LoadoutItem, scope: "global" | "project", theme: Theme): string {
	if (scope === "project") {
		const override = overrideBadge(item.projectOverride, theme);
		if (override !== undefined) return override;
	}
	return enabledBadge(scope === "global" ? item.globalEnabled : item.effectiveEnabled, theme);
}

/** The same facts the badges draw, in words, for the detail pane. */
export function scopeLabel(item: LoadoutItem, scope: "global" | "project"): string {
	if (scope === "project") {
		if (item.projectOverride === "load") return "enabled here";
		if (item.projectOverride === "unload") return "disabled here";
		return item.effectiveEnabled ? "inherited, enabled" : "inherited, disabled";
	}
	return item.globalEnabled ? "enabled" : "disabled";
}
