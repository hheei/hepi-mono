import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Display contract mirror of pi-ext-tools' MUTATION_GLYPH/MUTATION_TONE: how one
 * mutation outcome is drawn. The persisted `ApplyPatchToolDetails` carries the
 * outcome facts; pi-ext-ui never imports pi-ext-tools, so the glyph vocabulary is
 * restated here as part of the rendering contract it consumes.
 */
export const APPLY_PATCH_GLYPH: Record<string, string> = {
	pending: "⋯",
	applied: "✓",
	partial: "▲",
	fuzzy: "▲",
	unconfirmed: "▲",
	not_applied: "·",
	rejected: "✗",
};

export const APPLY_PATCH_TONE: Record<string, "success" | "warning" | "dim" | "error"> = {
	pending: "dim",
	applied: "success",
	partial: "warning",
	fuzzy: "warning",
	unconfirmed: "warning",
	not_applied: "dim",
	rejected: "error",
};

export function applyPatchGlyph(status: string, theme: Theme): string {
	const glyph = APPLY_PATCH_GLYPH[status] ?? "✗";
	const tone = APPLY_PATCH_TONE[status] ?? "error";
	return theme.fg(tone, glyph);
}
