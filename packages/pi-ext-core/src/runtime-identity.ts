import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RuntimeHost = Pick<ExtensionAPI, "events">;

/**
 * Resolves the object used to scope core state to one Pi runtime. Pi retains some
 * handlers across /reload, so the stable `events` object is preferred over the
 * newly created extension API object; the API itself is the fallback for hosts
 * without an object-valued event bus.
 */
export function runtimeIdentity(pi: RuntimeHost): object {
	const events: unknown = pi.events;
	return typeof events === "object" && events !== null ? events : pi;
}
