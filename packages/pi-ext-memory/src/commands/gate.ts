import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Entry, latestGateEnabled, OM_GATE } from "../session-ledger/index.js";

const USAGE = "Usage: /om [on|off]";

/**
 * Register `/om`: the per-session gate for observational memory.
 *
 * The gate is stored as a ledger entry on the current branch rather than an in-memory
 * flag, so `/tree` switches and `/resume` restore exactly what that branch recorded, and
 * no cached state can go stale. Reading it is `latestGateEnabled(branch)`; this command is
 * the only writer.
 */
export function registerGateCommand(pi: ExtensionAPI): void {
	pi.registerCommand("om", {
		description: "Turn observational memory on or off for this session (/om on|off)",
		handler: async (args, ctx) => {
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const requested = typeof args === "string" ? args.trim().toLowerCase() : "";
			const notify = (message: string) => ctx.ui.notify(message, "info");

			if (requested !== "on" && requested !== "off") {
				if (requested !== "") {
					notify(`Unknown option "${requested}". ${USAGE}`);
					return;
				}
				const state = latestGateEnabled(entries) ? "on" : "off";
				notify(`Observational memory is ${state} for this session. ${USAGE}`);
				return;
			}

			const enabled = requested === "on";
			if (latestGateEnabled(entries) === enabled) {
				notify(`Observational memory is already ${requested} for this session.`);
				return;
			}

			// Persisted before reporting, so the message never claims a state the branch
			// does not carry (a stale-context append would throw here).
			pi.appendEntry(OM_GATE, { enabled });
			notify(
				enabled
					? "Observational memory is on for this session; background workers resume."
					: "Observational memory is off for this session; memory is not read, written, or recalled.",
			);
		},
	});
}
