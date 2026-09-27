import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Entry, latestGateEnabled, OM_GATE } from "../session-ledger/index.js";

/**
 * The per-session gate for observational memory, exposed to the `/om` dispatcher.
 *
 * The gate is stored as a ledger entry on the current branch rather than an in-memory
 * flag, so `/tree` switches and `/resume` restore exactly what that branch recorded, and
 * no cached state can go stale. Reading it is `latestGateEnabled(branch)`; `setGateEnabled`
 * is the only writer.
 */
export function reportGateState(ctx: ExtensionCommandContext): void {
	const state = latestGateEnabled(ctx.sessionManager.getBranch() as Entry[]) ? "on" : "off";
	ctx.ui.notify(`Observational memory is ${state} for this session.`, "info");
}

export function setGateEnabled(
	pi: ExtensionAPI,
	enabled: boolean,
	ctx: ExtensionCommandContext,
): void {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (latestGateEnabled(entries) === enabled) {
		ctx.ui.notify(
			`Observational memory is already ${enabled ? "on" : "off"} for this session.`,
			"info",
		);
		return;
	}

	// Persisted before reporting, so the message never claims a state the branch does not
	// carry (a stale-context append would throw here).
	pi.appendEntry(OM_GATE, { enabled });
	ctx.ui.notify(
		enabled
			? "Observational memory is on for this session; background workers resume."
			: "Observational memory is off for this session; memory is not read, written, or recalled.",
		"info",
	);
}
