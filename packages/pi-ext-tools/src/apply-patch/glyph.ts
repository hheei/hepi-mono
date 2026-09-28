import type { ApplyPatchOperationStatus } from "./outcome.js";

/**
 * How one mutation outcome is drawn, in the Nerd Font vocabulary the framed tool status and the
 * todo rows already use. `apply_patch` operation rows and the remote `edit`/`write` failure lines
 * share it, so one outcome never draws two different symbols across the tools.
 */
export const MUTATION_GLYPH: Record<ApplyPatchOperationStatus, string> = {
	pending: "󰄰",
	applied: "󰄴",
	partial: "󰪡",
	fuzzy: "󰾞",
	unconfirmed: "󰘥",
	not_applied: "󰍷",
	rejected: "󰅚",
};

export const MUTATION_TONE: Record<
	ApplyPatchOperationStatus,
	"success" | "warning" | "dim" | "error"
> = {
	pending: "dim",
	applied: "success",
	partial: "warning",
	fuzzy: "warning",
	unconfirmed: "warning",
	not_applied: "dim",
	rejected: "error",
};
