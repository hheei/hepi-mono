import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RuntimeHost = Pick<ExtensionAPI, "events">;

/** Resolves the object used to scope core state to one Pi runtime. */
export function runtimeIdentity(pi: RuntimeHost): object {
	const events: unknown = pi.events;
	return typeof events === "object" && events !== null ? events : pi;
}
